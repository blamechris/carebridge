/**
 * Clinical review prompts for the AI oversight engine.
 * These are versioned and testable — changes to prompts are tracked.
 */

import { PROMPT_SECTIONS } from "./prompt-sections.js";

export const PROMPT_VERSION = "1.0.0";

export const CLINICAL_REVIEW_SYSTEM_PROMPT = `You are a clinical decision support system reviewing a patient's medical record.
Your role is to identify potential clinical concerns that might be missed when
multiple specialists each see only their own piece of the patient's care.

You are NOT diagnosing. You are flagging patterns that warrant clinician review.

For each concern you identify, respond with a JSON array. Each element must have:
1. "severity": "critical" (needs immediate attention), "warning" (review within 24h), or "info" (consider at next visit)
2. "category": one of "cross-specialty", "drug-interaction", "care-gap", "critical-value", "trend-concern", "documentation-discrepancy"
3. "summary": a concise one-sentence finding
4. "rationale": 2-4 sentences explaining the clinical reasoning
5. "suggested_action": what the clinician should consider doing
6. "notify_specialties": array of specialties that should be alerted

Focus especially on:
- Cross-specialty interactions (e.g., cancer + hematology + neurology)
- Medication interactions in the context of the full problem list
- Symptom patterns that span multiple provider notes
- Missing preventive care given the patient's risk factors
- Subtle trends in lab values that individually look fine but together suggest a pattern
- New symptoms that, combined with existing diagnoses, indicate elevated risk

Do NOT flag things that are clearly already being managed (check recent notes and flags).
If you find no concerns, return an empty array: []

Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.`;

/**
 * A single event in the unified 30-day patient timeline. Every modality
 * (vitals, labs, meds, notes, encounters) normalises into this shape so
 * the LLM can reason about sequence and clustering rather than only
 * modality-siloed snapshots.
 *
 * `detail` is a short, already-sanitized human-readable summary — never
 * the raw record. Patient identifiers are stripped upstream in the
 * context builder so this type is safe to drop into a prompt verbatim.
 */
export interface TimelineEvent {
  at: string; // ISO 8601 timestamp, used for sort + cluster detection
  category:
    | "vital"
    | "lab"
    | "medication"
    | "note"
    | "encounter"
    | "diagnosis"
    | "procedure";
  detail: string;
  specialty?: string;
  severity?: "info" | "warning" | "critical";
}

/**
 * A window in which several events occurred in close temporal
 * proximity. Clusters are the LLM's hint to look for causal chains
 * ("ED visit → new meds → lab drop three days later") that individual
 * snapshots can hide.
 */
export interface TemporalCluster {
  window: "same_day" | "same_week";
  start: string; // ISO 8601
  end: string; // ISO 8601
  event_count: number;
  categories: TimelineEvent["category"][];
  summary: string;
}

/**
 * A care gap surfaced by the deterministic pre-pass before the LLM
 * runs. These are explicit nudges ("no vitals recorded in 12 days")
 * rather than conclusions — the LLM decides whether the gap is
 * clinically meaningful in context.
 */
export interface GapDetected {
  description: string;
  since: string; // ISO 8601 of the last relevant activity, or gap start
  severity: "info" | "warning" | "critical";
}

export interface ReviewContext {
  patient: {
    age: number;
    sex: string;
    active_diagnoses: string[];
    allergies: string[];
  };
  active_medications: {
    name: string;
    dose: string;
    route: string;
    frequency: string;
    started_at: string;
  }[];
  latest_vitals: Record<string, {
    value: number;
    unit: string;
    recorded_at: string;
    trend?: "rising" | "falling" | "stable";
  }>;
  recent_labs?: {
    test_name: string;
    value: number;
    unit: string;
    flag: string | null;
    trend?: "rising" | "falling" | "stable";
    collected_at: string;
  }[];
  /**
   * Phase A3: unified 30-day event stream across modalities, sorted
   * oldest → newest so the LLM reads the patient's recent story in
   * chronological order. Undefined on legacy callers that have not
   * been migrated to the temporal context builder.
   */
  timeline_30d?: TimelineEvent[];
  /**
   * Phase A3: same-day / same-week event bursts detected over
   * `timeline_30d`. Empty array when no clustering is observed.
   */
  temporal_clusters?: TemporalCluster[];
  /**
   * Phase A3: deterministic pre-pass gap findings (e.g., "no vitals
   * in 12 days"). Empty array when no gaps are detected.
   */
  gaps_detected?: GapDetected[];
  triggering_event: {
    type: string;
    summary: string;
    detail: string;
  };
  recent_flags: {
    severity: string;
    summary: string;
    status: string;
    created_at: string;
  }[];
  care_team: {
    name: string;
    specialty: string;
    recent_note_date?: string;
  }[];
}

export function buildReviewPrompt(context: ReviewContext): string {
  const timelineSection = renderTimelineSection(context.timeline_30d);
  const clustersSection = renderClustersSection(context.temporal_clusters);
  const gapsSection = renderGapsSection(context.gaps_detected);

  return `PATIENT CLINICAL CONTEXT
========================

${PROMPT_SECTIONS.DEMOGRAPHICS}: ${context.patient.age} year old ${context.patient.sex}

${PROMPT_SECTIONS.DIAGNOSES}:
${context.patient.active_diagnoses.map((d) => `  - ${d}`).join("\n") || "  None documented"}

${PROMPT_SECTIONS.ALLERGIES}:
${context.patient.allergies.map((a) => `  - ${a}`).join("\n") || "  NKDA"}

${PROMPT_SECTIONS.MEDICATIONS}:
${context.active_medications.map((m) => `  - ${m.name} ${m.dose} ${m.route} ${m.frequency} (since ${m.started_at})`).join("\n") || "  None"}

${PROMPT_SECTIONS.VITALS}:
${Object.entries(context.latest_vitals).map(([type, v]) => `  - ${type}: ${v.value} ${v.unit} (${v.recorded_at})${v.trend ? ` [${v.trend}]` : ""}`).join("\n") || "  None recorded"}

${context.recent_labs ? `${PROMPT_SECTIONS.LABS}:
${context.recent_labs.map((l) => `  - ${l.test_name}: ${l.value} ${l.unit}${l.flag ? ` [${l.flag}]` : ""}${l.trend ? ` (${l.trend})` : ""} (${l.collected_at})`).join("\n")}` : ""}
${timelineSection}${clustersSection}${gapsSection}
${PROMPT_SECTIONS.CARE_TEAM}:
${context.care_team.map((c) => `  - ${c.name} (${c.specialty})${c.recent_note_date ? ` — last note: ${c.recent_note_date}` : ""}`).join("\n") || "  Not documented"}

${PROMPT_SECTIONS.FLAGS}:
${context.recent_flags.filter((f) => f.status === "open").map((f) => `  - [${f.severity}] ${f.summary} (${f.created_at})`).join("\n") || "  None"}

${PROMPT_SECTIONS.TRIGGERING_EVENT}
================
Type: ${context.triggering_event.type}
Summary: ${context.triggering_event.summary}
Detail:
${context.triggering_event.detail}

Review this patient's record for clinical concerns, paying special attention to the triggering event in the context of the full clinical picture.`;
}

/**
 * Render the 30-day timeline as a chronological bulleted list. Returns
 * an empty string when the timeline is absent (legacy callers) or
 * empty, so the surrounding prompt template collapses cleanly.
 */
function renderTimelineSection(timeline: TimelineEvent[] | undefined): string {
  if (!timeline || timeline.length === 0) return "";
  const lines = timeline
    .map((e) => {
      const sev = e.severity ? ` [${e.severity}]` : "";
      const spec = e.specialty ? ` (${e.specialty})` : "";
      return `  - ${e.at} ${e.category}${spec}${sev}: ${e.detail}`;
    })
    .join("\n");
  return `\n${PROMPT_SECTIONS.TIMELINE}:\n${lines}\n`;
}

function renderClustersSection(
  clusters: TemporalCluster[] | undefined,
): string {
  if (!clusters || clusters.length === 0) return "";
  const lines = clusters
    .map(
      (c) =>
        `  - [${c.window}] ${c.start} → ${c.end}: ${c.event_count} events across ${c.categories.join(", ")} — ${c.summary}`,
    )
    .join("\n");
  return `\n${PROMPT_SECTIONS.CLUSTERS}:\n${lines}\n`;
}

function renderGapsSection(gaps: GapDetected[] | undefined): string {
  if (!gaps || gaps.length === 0) return "";
  const lines = gaps
    .map((g) => `  - [${g.severity}] ${g.description} (since ${g.since})`)
    .join("\n");
  return `\n${PROMPT_SECTIONS.GAPS}:\n${lines}\n`;
}

export interface LLMFlagOutput {
  severity: "critical" | "warning" | "info";
  category: string;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

export function parseReviewResponse(response: string): LLMFlagOutput[] {
  try {
    const parsed = JSON.parse(response);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is LLMFlagOutput =>
        typeof item === "object" &&
        item !== null &&
        "severity" in item &&
        "summary" in item &&
        "rationale" in item
    );
  } catch {
    return [];
  }
}
