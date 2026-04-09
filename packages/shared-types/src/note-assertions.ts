/**
 * Structured assertions extracted from a clinical note by the AI oversight
 * note-extractor (Phase A1).
 *
 * The free-text body of a SOAP / progress / discharge note is opaque to the
 * downstream rules engine. The extractor turns it into a typed
 * {@link NoteAssertionsPayload} that contradiction- and gap-detection rules
 * can reason over deterministically.
 *
 * Storage: persisted in `note_assertions.payload` as encryptedJsonb so it
 * sits at rest with the same protection as the source note's `sections`
 * column. See packages/db-schema/src/schema/note-assertions.ts.
 *
 * Provenance: every payload is tagged with the model id and prompt version
 * that produced it so retroactive comparisons are possible when prompts or
 * models change.
 */

/** A symptom the patient (or family / triage staff) reported as present. */
export interface SymptomReport {
  /** Canonical symptom name, lowercase. e.g. "chest pain", "headache". */
  name: string;
  /**
   * Onset description as it appears in the note. Free text — the extractor
   * is told NOT to invent dates and to leave this null if absent.
   * Examples: "3 days ago", "since this morning", "intermittent for 2 weeks".
   */
  onset: string | null;
  /**
   * Severity as documented. Free text rather than ordinal so the extractor
   * doesn't fabricate a scale. Examples: "mild", "8/10", "worse than before".
   */
  severity: string | null;
  /**
   * Verbatim or near-verbatim text fragment from the note that supports
   * this assertion. Used by contradiction rules to show the clinician
   * exactly which sentence the AI relied on. Limited to 240 chars by the
   * parser to keep payloads bounded.
   */
  evidence_quote: string | null;
}

/**
 * An assessment / impression — the clinician's judgement of an active
 * problem from the Assessment section of a SOAP note (or equivalent).
 */
export interface Assessment {
  /** Problem name as documented. e.g. "left lower lobe pneumonia". */
  problem: string;
  /**
   * Status the clinician asserts: improving, worsening, stable, new,
   * resolved, unchanged, or unknown if not stated. The extractor must NOT
   * invent a status — it returns "unknown" when the note does not say.
   */
  status:
    | "new"
    | "improving"
    | "worsening"
    | "stable"
    | "resolved"
    | "unchanged"
    | "unknown";
  /** Verbatim fragment supporting the status. */
  evidence_quote: string | null;
}

/** A planned action from the Plan section of the note. */
export interface PlanItem {
  /** Action verb + object. e.g. "order chest x-ray", "start metoprolol". */
  action: string;
  /**
   * Target follow-up date if explicitly stated, in the format the note
   * uses. The extractor MUST NOT compute relative dates ("in 2 weeks");
   * if the note only says "in 2 weeks" it stays as that string. Null when
   * no follow-up date is stated.
   */
  target_followup: string | null;
  /**
   * Specialty that ordered or owns the action, if the note attributes it.
   * e.g. "cardiology", "primary_care", "oncology". Null when unattributed.
   */
  ordered_by_specialty: string | null;
  /** Verbatim fragment supporting the action. */
  evidence_quote: string | null;
}

/**
 * A test, lab, imaging, or measurement result the note CITES (not creates).
 * Used by stale-evidence rules: if a note cites an "echo from 8 months ago"
 * as current evidence, that's a flag.
 */
export interface ReferencedResult {
  /**
   * Result type as documented. e.g. "echo", "EF", "INR", "chest CT".
   * Lowercase, normalized.
   */
  type: string;
  /** Value as documented, e.g. "55%", "2.3", "stable", "negative". */
  value: string;
  /**
   * Date the note attributes to the result, in whatever form the note uses.
   * Null when the note does not say when the result was obtained.
   */
  asserted_date: string | null;
  /** Verbatim fragment supporting the citation. */
  evidence_quote: string | null;
}

/**
 * The full structured payload extracted from a single signed note.
 *
 * Design notes:
 *   - All collections are required (may be empty arrays). The parser must
 *     normalize missing keys to []. This keeps consumers branch-free.
 *   - `symptoms_denied` is a flat string list because contradiction rules
 *     only need the symptom name, not severity / onset.
 *   - `extracted_at` is set by the extractor at persist time, NOT by the
 *     LLM. The LLM does not see the current date; that's intentional —
 *     date hallucinations are a known failure mode.
 */
export interface NoteAssertionsPayload {
  symptoms_reported: SymptomReport[];
  /** Symptoms the note explicitly says the patient denies / has not had. */
  symptoms_denied: string[];
  assessments: Assessment[];
  plan_items: PlanItem[];
  referenced_results: ReferencedResult[];
  /**
   * Free-text top-level summary the LLM produces (one or two sentences).
   * Bounded by the parser to 480 chars.
   */
  one_line_summary: string;
}

/** Extraction status recorded on the note_assertions row. */
export type NoteExtractionStatus =
  | "success"
  | "parse_failed"
  | "llm_disabled"
  | "llm_failed"
  | "sanitization_failed"
  | "consent_required";
