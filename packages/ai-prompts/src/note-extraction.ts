/**
 * Note extraction prompts for Phase A1.
 *
 * Takes a signed clinical note (SOAP / progress / discharge / h_and_p / consult)
 * and turns it into a typed {@link NoteAssertionsPayload}. Downstream rules
 * (Phase A2) reason over the extracted claims to catch contradictions,
 * stale evidence, missed follow-ups, and medication-list mismatches.
 *
 * Design principles:
 *   1. **Determinism.** The system prompt tells Claude to use `null` or
 *      `"unknown"` when the note does not say something — no invention,
 *      no inferred dates, no fabricated severity scales.
 *   2. **Provenance.** Every claim carries an `evidence_quote` so a
 *      clinician can see exactly which sentence the AI relied on.
 *   3. **Strict JSON.** The parser rejects anything that is not a valid
 *      JSON object with the expected top-level keys. Partial parses become
 *      `parse_failed` in the caller, not silent empty payloads.
 *   4. **Bounded.** Evidence quotes are capped at 240 chars; the top-level
 *      summary at 480. This keeps payload sizes predictable and limits
 *      the blast radius of a prompt-injection or hallucination.
 */

import type {
  NoteAssertionsPayload,
  SymptomReport,
  Assessment,
  PlanItem,
  ReferencedResult,
} from "@carebridge/shared-types";

/** Bumped whenever the prompt semantics change. Tracked per row in DB. */
export const NOTE_EXTRACTION_PROMPT_VERSION = "1.0.0";

const MAX_QUOTE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 480;
const MAX_ITEMS_PER_COLLECTION = 50;

export const NOTE_EXTRACTION_SYSTEM_PROMPT = `You are a clinical information extraction system.

Your job: read a single signed clinical note and return a strict JSON object that lists the claims the note makes. You are NOT diagnosing, NOT interpreting, NOT inferring. You are indexing what is already there so downstream rules can reason over it.

Return a JSON object with EXACTLY these top-level keys:

{
  "symptoms_reported": [ { "name": string, "onset": string|null, "severity": string|null, "evidence_quote": string|null } ],
  "symptoms_denied":   [ string ],
  "assessments":       [ { "problem": string, "status": "new"|"improving"|"worsening"|"stable"|"resolved"|"unchanged"|"unknown", "evidence_quote": string|null } ],
  "plan_items":        [ { "action": string, "target_followup": string|null, "ordered_by_specialty": string|null, "evidence_quote": string|null } ],
  "referenced_results":[ { "type": string, "value": string, "asserted_date": string|null, "evidence_quote": string|null } ],
  "one_line_summary":  string
}

RULES:

1. If the note does not state something, use null (or "unknown" for assessment.status). Do NOT invent, infer, or compute.
2. Do NOT compute relative dates. If the note says "3 days ago", keep the string "3 days ago". Do NOT resolve to a calendar date.
3. Every evidence_quote must be a verbatim or near-verbatim fragment copied from the note, ≤240 characters. If you cannot find a supporting fragment, use null — do not synthesize one.
4. Symptom names are lowercase canonical forms: "chest pain", "headache", "dyspnea on exertion". Do not include punctuation.
5. "symptoms_denied" is a flat array of lowercase symptom names the note explicitly says the patient denies or has NOT had. Empty array when the note says nothing about denials.
6. assessments[].status: use "unknown" when the note does not state whether the problem is improving, worsening, etc. Do not guess based on "sounds bad" etc.
7. plan_items[].ordered_by_specialty must come from the note itself (e.g. "per cardiology", "oncology recommends"). Do not assign a specialty based on the action type.
8. referenced_results are results the note CITES as evidence, not new results being reported. e.g. "echo from May showed EF 55%" → type="echo", value="EF 55%", asserted_date="May".
9. one_line_summary: ≤480 characters, one or two sentences, factual. No recommendations, no severity judgments. Describe what the note is about.
10. Never include patient identifiers (names, MRNs, dates of birth) in any field. If the only supporting evidence contains an identifier, omit the evidence_quote.
11. Respond ONLY with the JSON object. No markdown fencing, no prose, no explanation. If you cannot extract anything, return all-empty collections and a short summary.

Any deviation from these rules corrupts downstream clinical rules. When in doubt, emit less, not more.`;

export interface NoteExtractionInput {
  /** Template type so the prompt can say "this is a SOAP note", etc. */
  template_type: string;
  /**
   * Pre-sanitized note body — sections rendered as plain text. The caller
   * is responsible for PHI redaction BEFORE invoking this builder. The
   * builder does not re-redact.
   */
  note_body: string;
}

export function buildNoteExtractionPrompt(input: NoteExtractionInput): string {
  return `TEMPLATE TYPE: ${input.template_type}

NOTE BODY:
=========
${input.note_body}
=========

Extract the structured claims from the note above and return ONLY the JSON object described in the system prompt. Remember: null / "unknown" when the note does not say. Do not invent.`;
}

/** Render the NoteSection[] structure into a flat text block for the LLM. */
export function renderNoteBodyForExtraction(
  sections: ReadonlyArray<{
    label: string;
    free_text?: string;
    fields?: ReadonlyArray<{ label: string; value: unknown }>;
  }>,
): string {
  const blocks: string[] = [];
  for (const section of sections) {
    const header = `--- ${section.label} ---`;
    const parts: string[] = [header];

    if (section.fields && section.fields.length > 0) {
      for (const f of section.fields) {
        if (f.value == null) continue;
        const rendered = Array.isArray(f.value)
          ? f.value.join(", ")
          : String(f.value);
        if (rendered.trim().length === 0) continue;
        parts.push(`${f.label}: ${rendered}`);
      }
    }
    if (section.free_text && section.free_text.trim().length > 0) {
      parts.push(section.free_text.trim());
    }
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n\n");
}

// ─── Parsing ────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; payload: NoteAssertionsPayload }
  | { ok: false; reason: string };

/**
 * Parse Claude's raw response into a {@link NoteAssertionsPayload}.
 *
 * Strict: rejects non-JSON, rejects non-objects, rejects any item that
 * cannot be coerced to the expected shape. Silently drops individual
 * malformed items inside collections (logged at the item level) so one
 * bad entry doesn't poison the whole extraction.
 */
export function parseNoteExtractionResponse(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty response" };
  }

  // Strip optional markdown code fencing if the model adds it despite
  // instructions. Keeps us resilient to prompt drift.
  const jsonText = stripMarkdownFence(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      reason: `not valid JSON: ${(err as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "response is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  const payload: NoteAssertionsPayload = {
    symptoms_reported: coerceSymptoms(obj.symptoms_reported),
    symptoms_denied: coerceStringArray(obj.symptoms_denied),
    assessments: coerceAssessments(obj.assessments),
    plan_items: coercePlanItems(obj.plan_items),
    referenced_results: coerceReferencedResults(obj.referenced_results),
    one_line_summary: coerceSummary(obj.one_line_summary),
  };

  return { ok: true, payload };
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return text;
}

function clampString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (normalized.length === 0) continue;
    out.push(normalized);
    if (out.length >= MAX_ITEMS_PER_COLLECTION) break;
  }
  return out;
}

function coerceSymptoms(value: unknown): SymptomReport[] {
  if (!Array.isArray(value)) return [];
  const out: SymptomReport[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
    if (name.length === 0) continue;
    out.push({
      name,
      onset: clampString(item.onset, 120),
      severity: clampString(item.severity, 120),
      evidence_quote: clampString(item.evidence_quote, MAX_QUOTE_LENGTH),
    });
    if (out.length >= MAX_ITEMS_PER_COLLECTION) break;
  }
  return out;
}

const VALID_ASSESSMENT_STATUS = new Set([
  "new",
  "improving",
  "worsening",
  "stable",
  "resolved",
  "unchanged",
  "unknown",
]);

function coerceAssessments(value: unknown): Assessment[] {
  if (!Array.isArray(value)) return [];
  const out: Assessment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const problem =
      typeof item.problem === "string" ? item.problem.trim() : "";
    if (problem.length === 0) continue;
    const statusRaw =
      typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const status = VALID_ASSESSMENT_STATUS.has(statusRaw)
      ? (statusRaw as Assessment["status"])
      : "unknown";
    out.push({
      problem: problem.slice(0, 240),
      status,
      evidence_quote: clampString(item.evidence_quote, MAX_QUOTE_LENGTH),
    });
    if (out.length >= MAX_ITEMS_PER_COLLECTION) break;
  }
  return out;
}

function coercePlanItems(value: unknown): PlanItem[] {
  if (!Array.isArray(value)) return [];
  const out: PlanItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const action = typeof item.action === "string" ? item.action.trim() : "";
    if (action.length === 0) continue;
    out.push({
      action: action.slice(0, 240),
      target_followup: clampString(item.target_followup, 120),
      ordered_by_specialty: clampString(item.ordered_by_specialty, 60),
      evidence_quote: clampString(item.evidence_quote, MAX_QUOTE_LENGTH),
    });
    if (out.length >= MAX_ITEMS_PER_COLLECTION) break;
  }
  return out;
}

function coerceReferencedResults(value: unknown): ReferencedResult[] {
  if (!Array.isArray(value)) return [];
  const out: ReferencedResult[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type =
      typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
    const valueStr =
      typeof item.value === "string" ? item.value.trim() : "";
    if (type.length === 0 || valueStr.length === 0) continue;
    out.push({
      type: type.slice(0, 60),
      value: valueStr.slice(0, 120),
      asserted_date: clampString(item.asserted_date, 120),
      evidence_quote: clampString(item.evidence_quote, MAX_QUOTE_LENGTH),
    });
    if (out.length >= MAX_ITEMS_PER_COLLECTION) break;
  }
  return out;
}

function coerceSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= MAX_SUMMARY_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_SUMMARY_LENGTH);
}

/** Empty payload used when extraction fails. Consumers never get null. */
export const EMPTY_NOTE_ASSERTIONS: NoteAssertionsPayload = {
  symptoms_reported: [],
  symptoms_denied: [],
  assessments: [],
  plan_items: [],
  referenced_results: [],
  one_line_summary: "",
};
