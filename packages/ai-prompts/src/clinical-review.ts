/**
 * Clinical review prompts for the AI oversight engine.
 * These are versioned and testable — changes to prompts are tracked.
 */

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
  return `PATIENT CLINICAL CONTEXT
========================

Demographics: ${context.patient.age} year old ${context.patient.sex}

Active Diagnoses:
${context.patient.active_diagnoses.map((d) => `  - ${d}`).join("\n") || "  None documented"}

Allergies:
${context.patient.allergies.map((a) => `  - ${a}`).join("\n") || "  NKDA"}

Active Medications:
${context.active_medications.map((m) => `  - ${m.name} ${m.dose} ${m.route} ${m.frequency} (since ${m.started_at})`).join("\n") || "  None"}

Latest Vitals:
${Object.entries(context.latest_vitals).map(([type, v]) => `  - ${type}: ${v.value} ${v.unit} (${v.recorded_at})${v.trend ? ` [${v.trend}]` : ""}`).join("\n") || "  None recorded"}

${context.recent_labs ? `Recent Lab Results:
${context.recent_labs.map((l) => `  - ${l.test_name}: ${l.value} ${l.unit}${l.flag ? ` [${l.flag}]` : ""}${l.trend ? ` (${l.trend})` : ""} (${l.collected_at})`).join("\n")}` : ""}

Care Team:
${context.care_team.map((c) => `  - ${c.name} (${c.specialty})${c.recent_note_date ? ` — last note: ${c.recent_note_date}` : ""}`).join("\n") || "  Not documented"}

Recent Open Flags:
${context.recent_flags.filter((f) => f.status === "open").map((f) => `  - [${f.severity}] ${f.summary} (${f.created_at})`).join("\n") || "  None"}

TRIGGERING EVENT
================
Type: ${context.triggering_event.type}
Summary: ${context.triggering_event.summary}
Detail:
${context.triggering_event.detail}

Review this patient's record for clinical concerns, paying special attention to the triggering event in the context of the full clinical picture.`;
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
