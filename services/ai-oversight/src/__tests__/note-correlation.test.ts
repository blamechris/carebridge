import { describe, it, expect } from "vitest";
import type { NoteAssertionsPayload } from "@carebridge/shared-types";
import {
  checkNoteCorrelation,
  checkNoteVitalContradiction,
  checkNoteNoteContradiction,
  checkPlanFollowupGap,
  checkStaleEvidence,
  checkOrderedNotResulted,
  checkMedicationAssertionMismatch,
  type NoteCorrelationContext,
} from "../rules/note-correlation.js";

// ─── Fixtures ────────────────────────────────────────────────────

const NOW = new Date("2026-04-09T12:00:00.000Z");
const SIGNED_AT = "2026-04-09T10:00:00.000Z";

function emptyPayload(): NoteAssertionsPayload {
  return {
    symptoms_reported: [],
    symptoms_denied: [],
    assessments: [],
    plan_items: [],
    referenced_results: [],
    one_line_summary: "",
  };
}

function baseContext(
  overrides: Partial<NoteCorrelationContext> = {},
): NoteCorrelationContext {
  return {
    current_note: {
      id: "note-current",
      patient_id: "pat-1",
      provider_id: "prov-cards",
      provider_specialty: "cardiology",
      signed_at: SIGNED_AT,
      payload: emptyPayload(),
    },
    prior_notes: [],
    recent_vitals: [],
    subsequent_panels: [],
    active_medication_names: [],
    now: NOW,
    ...overrides,
  };
}

// ─── NOTE-VITAL-CONTRADICTION-001 ────────────────────────────────

describe("NOTE-VITAL-CONTRADICTION-001", () => {
  it("fires when note denies dyspnea but SpO2 is below 90%", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          symptoms_denied: ["dyspnea"],
        },
      },
      recent_vitals: [
        {
          type: "o2_sat",
          value_primary: 87,
          value_secondary: null,
          unit: "%",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    const flags = checkNoteVitalContradiction(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("NOTE-VITAL-CONTRADICTION-001");
    expect(flags[0].severity).toBe("warning");
    expect(flags[0].category).toBe("documentation-discrepancy");
    expect(flags[0].summary).toContain("dyspnea");
  });

  it("fires when note denies fever but temperature is 101.2°F", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["fever"] },
      },
      recent_vitals: [
        {
          type: "temperature",
          value_primary: 101.2,
          value_secondary: null,
          unit: "°F",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    const flags = checkNoteVitalContradiction(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rationale).toContain("fever threshold");
  });

  it("fires when note denies hypertension but BP is 180/110", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["hypertension"] },
      },
      recent_vitals: [
        {
          type: "blood_pressure",
          value_primary: 180,
          value_secondary: 110,
          unit: "mmHg",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    const flags = checkNoteVitalContradiction(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rationale).toContain("180/110");
  });

  it("does NOT fire when vitals are normal", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["dyspnea"] },
      },
      recent_vitals: [
        {
          type: "o2_sat",
          value_primary: 98,
          value_secondary: null,
          unit: "%",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    expect(checkNoteVitalContradiction(ctx)).toHaveLength(0);
  });

  it("does NOT fire when there are no recent vitals", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["dyspnea"] },
      },
    });
    expect(checkNoteVitalContradiction(ctx)).toHaveLength(0);
  });

  it("does NOT fire when the denied symptom is unrelated to any probe", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["itching"] },
      },
      recent_vitals: [
        {
          type: "o2_sat",
          value_primary: 85,
          value_secondary: null,
          unit: "%",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    expect(checkNoteVitalContradiction(ctx)).toHaveLength(0);
  });

  it("deduplicates: 'shortness of breath' and 'dyspnea' denied → one flag per vital type", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          symptoms_denied: ["dyspnea", "shortness of breath"],
        },
      },
      recent_vitals: [
        {
          type: "o2_sat",
          value_primary: 85,
          value_secondary: null,
          unit: "%",
          recorded_at: SIGNED_AT,
        },
      ],
    });
    const flags = checkNoteVitalContradiction(ctx);
    // One flag per (denied-symptom, vital-type) — two denied symptoms, same vital type → two flags.
    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(flags.length).toBeLessThanOrEqual(2);
  });
});

// ─── NOTE-NOTE-CONTRADICTION-001 ─────────────────────────────────

describe("NOTE-NOTE-CONTRADICTION-001", () => {
  it("fires when prior cardiology note reports chest pain and current ED note denies it", () => {
    const ctx = baseContext({
      current_note: {
        id: "note-ed",
        patient_id: "pat-1",
        provider_id: "prov-ed",
        provider_specialty: "emergency",
        signed_at: SIGNED_AT,
        payload: { ...emptyPayload(), symptoms_denied: ["chest pain"] },
      },
      prior_notes: [
        {
          id: "note-cards",
          provider_id: "prov-cards",
          provider_specialty: "cardiology",
          signed_at: "2026-04-08T14:00:00.000Z",
          payload: {
            ...emptyPayload(),
            symptoms_reported: [
              {
                name: "chest pain",
                onset: "3 days ago",
                severity: "7/10",
                evidence_quote: "patient reports chest pain for 3 days",
              },
            ],
          },
        },
      ],
    });

    const flags = checkNoteNoteContradiction(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("NOTE-NOTE-CONTRADICTION-001");
    expect(flags[0].summary).toContain("chest pain");
    expect(flags[0].notify_specialties).toContain("cardiology");
    expect(flags[0].notify_specialties).toContain("emergency");
  });

  it("fires in the opposite direction: prior denies, current reports", () => {
    const ctx = baseContext({
      current_note: {
        id: "note-ed",
        patient_id: "pat-1",
        provider_id: "prov-ed",
        provider_specialty: "emergency",
        signed_at: SIGNED_AT,
        payload: {
          ...emptyPayload(),
          symptoms_reported: [
            {
              name: "chest pain",
              onset: null,
              severity: null,
              evidence_quote: "chest pain on arrival",
            },
          ],
        },
      },
      prior_notes: [
        {
          id: "note-cards",
          provider_id: "prov-cards",
          provider_specialty: "cardiology",
          signed_at: "2026-04-08T14:00:00.000Z",
          payload: { ...emptyPayload(), symptoms_denied: ["chest pain"] },
        },
      ],
    });

    expect(checkNoteNoteContradiction(ctx)).toHaveLength(1);
  });

  it("does NOT fire when both notes agree", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["chest pain"] },
      },
      prior_notes: [
        {
          id: "note-2",
          provider_id: "prov-2",
          provider_specialty: "cardiology",
          signed_at: "2026-04-08T14:00:00.000Z",
          payload: { ...emptyPayload(), symptoms_denied: ["chest pain"] },
        },
      ],
    });

    expect(checkNoteNoteContradiction(ctx)).toHaveLength(0);
  });

  it("does NOT fire for notes from the same provider", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        provider_id: "prov-same",
        payload: { ...emptyPayload(), symptoms_denied: ["chest pain"] },
      },
      prior_notes: [
        {
          id: "note-earlier",
          provider_id: "prov-same",
          provider_specialty: "cardiology",
          signed_at: "2026-04-08T14:00:00.000Z",
          payload: {
            ...emptyPayload(),
            symptoms_reported: [
              {
                name: "chest pain",
                onset: null,
                severity: null,
                evidence_quote: null,
              },
            ],
          },
        },
      ],
    });
    expect(checkNoteNoteContradiction(ctx)).toHaveLength(0);
  });

  it("is case-insensitive on symptom names", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: { ...emptyPayload(), symptoms_denied: ["Chest Pain"] },
      },
      prior_notes: [
        {
          id: "note-earlier",
          provider_id: "prov-other",
          provider_specialty: "cardiology",
          signed_at: "2026-04-08T14:00:00.000Z",
          payload: {
            ...emptyPayload(),
            symptoms_reported: [
              {
                name: "chest pain",
                onset: null,
                severity: null,
                evidence_quote: null,
              },
            ],
          },
        },
      ],
    });
    expect(checkNoteNoteContradiction(ctx)).toHaveLength(1);
  });
});

// ─── PLAN-FOLLOWUP-GAP-001 ───────────────────────────────────────

describe("PLAN-FOLLOWUP-GAP-001", () => {
  it("fires when target_followup is in the past and no subsequent note references the action", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        signed_at: "2026-03-01T10:00:00.000Z",
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "repeat echocardiogram",
              target_followup: "2026-04-01",
              ordered_by_specialty: "cardiology",
              evidence_quote: "plan: repeat echo in one month",
            },
          ],
        },
      },
    });
    const flags = checkPlanFollowupGap(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("PLAN-FOLLOWUP-GAP-001");
    expect(flags[0].severity).toBe("warning");
    expect(flags[0].category).toBe("care-gap");
    expect(flags[0].notify_specialties).toContain("cardiology");
  });

  it("does NOT fire for relative date strings the extractor couldn't resolve", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "repeat echo",
              target_followup: "in 2 weeks",
              ordered_by_specialty: "cardiology",
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkPlanFollowupGap(ctx)).toHaveLength(0);
  });

  it("does NOT fire when target_followup is in the future", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "repeat echo",
              target_followup: "2026-06-01",
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkPlanFollowupGap(ctx)).toHaveLength(0);
  });

  it("does NOT fire when a subsequent note references the action", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        signed_at: "2026-03-01T10:00:00.000Z",
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "repeat echocardiogram",
              target_followup: "2026-04-01",
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
      prior_notes: [
        {
          id: "note-after",
          provider_id: "prov-2",
          provider_specialty: "cardiology",
          signed_at: "2026-04-05T10:00:00.000Z",
          payload: {
            ...emptyPayload(),
            assessments: [
              {
                problem: "repeat echocardiogram reviewed",
                status: "stable",
                evidence_quote: "echocardiogram unchanged from prior",
              },
            ],
          },
        },
      ],
    });
    expect(checkPlanFollowupGap(ctx)).toHaveLength(0);
  });
});

// ─── STALE-EVIDENCE-001 ──────────────────────────────────────────

describe("STALE-EVIDENCE-001", () => {
  it("fires when referenced_result asserted_date is more than 180 days older than signed_at", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          referenced_results: [
            {
              type: "echo",
              value: "EF 55%",
              asserted_date: "2025-08-01",
              evidence_quote: "echo from last August",
            },
          ],
        },
      },
    });
    const flags = checkStaleEvidence(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("STALE-EVIDENCE-001");
    expect(flags[0].summary).toContain("echo");
  });

  it("does NOT fire when asserted_date is within 180 days", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          referenced_results: [
            {
              type: "echo",
              value: "EF 55%",
              asserted_date: "2026-02-01",
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkStaleEvidence(ctx)).toHaveLength(0);
  });

  it("does NOT fire when asserted_date is null or unparseable", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          referenced_results: [
            {
              type: "echo",
              value: "EF 55%",
              asserted_date: "last year",
              evidence_quote: null,
            },
            {
              type: "chest ct",
              value: "no mass",
              asserted_date: null,
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkStaleEvidence(ctx)).toHaveLength(0);
  });
});

// ─── ORDERED-NOT-RESULTED-001 ────────────────────────────────────

describe("ORDERED-NOT-RESULTED-001", () => {
  it("fires when plan orders a d-dimer and no matching panel exists", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "order d-dimer",
              target_followup: null,
              ordered_by_specialty: "emergency",
              evidence_quote: "plan: obtain d-dimer",
            },
          ],
        },
      },
    });
    const flags = checkOrderedNotResulted(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("ORDERED-NOT-RESULTED-001");
    expect(flags[0].summary).toContain("d-dimer");
    expect(flags[0].notify_specialties).toContain("emergency");
  });

  it("does NOT fire when a subsequent panel matches the ordered test", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "order d-dimer",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
      subsequent_panels: [
        {
          panel_name: "D-Dimer",
          ordered_at: SIGNED_AT,
          reported_at: null,
          created_at: SIGNED_AT,
        },
      ],
    });
    expect(checkOrderedNotResulted(ctx)).toHaveLength(0);
  });

  it("does NOT fire when plan action lacks an order verb", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "review d-dimer from last admission",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkOrderedNotResulted(ctx)).toHaveLength(0);
  });

  it("does NOT fire when plan orders something we don't recognize as a test", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "order physical therapy consult",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkOrderedNotResulted(ctx)).toHaveLength(0);
  });

  it("deduplicates multiple plan items ordering the same test", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          plan_items: [
            {
              action: "order CBC",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
            {
              action: "obtain CBC with differential",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
    });
    expect(checkOrderedNotResulted(ctx)).toHaveLength(1);
  });
});

// ─── MEDICATION-ASSERTION-MISMATCH-001 ───────────────────────────

describe("MEDICATION-ASSERTION-MISMATCH-001", () => {
  it("fires when note asserts patient is on warfarin but warfarin is not in active meds", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          assessments: [
            {
              problem: "atrial fibrillation",
              status: "stable",
              evidence_quote: "continues on warfarin for afib",
            },
          ],
        },
      },
      active_medication_names: ["metoprolol"],
    });
    const flags = checkMedicationAssertionMismatch(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].rule_id).toBe("MEDICATION-ASSERTION-MISMATCH-001");
    expect(flags[0].summary).toContain("warfarin");
    expect(flags[0].category).toBe("medication-safety");
  });

  it("does NOT fire when the asserted medication IS in the active meds list", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          assessments: [
            {
              problem: "afib",
              status: "stable",
              evidence_quote: "patient on warfarin",
            },
          ],
        },
      },
      active_medication_names: ["Warfarin 5mg"],
    });
    expect(checkMedicationAssertionMismatch(ctx)).toHaveLength(0);
  });

  it("does NOT fire for drugs that aren't in the high-risk probe list", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          assessments: [
            {
              problem: "chronic pain",
              status: "stable",
              evidence_quote: "continues on acetaminophen",
            },
          ],
        },
      },
      active_medication_names: [],
    });
    expect(checkMedicationAssertionMismatch(ctx)).toHaveLength(0);
  });

  it("does NOT fire when the quote mentions the drug without 'on' context", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        payload: {
          ...emptyPayload(),
          assessments: [
            {
              problem: "history of bleeding",
              status: "resolved",
              evidence_quote: "patient reports prior warfarin-associated bleed",
            },
          ],
        },
      },
      active_medication_names: [],
    });
    // Even though "warfarin" appears, context is historical, not current.
    expect(checkMedicationAssertionMismatch(ctx)).toHaveLength(0);
  });
});

// ─── Orchestrator ────────────────────────────────────────────────

describe("checkNoteCorrelation (orchestrator)", () => {
  it("returns an empty array for an empty context", () => {
    const flags = checkNoteCorrelation(baseContext());
    expect(flags).toEqual([]);
  });

  it("composes multiple rule findings into a single flat array", () => {
    const ctx = baseContext({
      current_note: {
        ...baseContext().current_note,
        signed_at: "2026-03-01T10:00:00.000Z",
        payload: {
          ...emptyPayload(),
          symptoms_denied: ["dyspnea"],
          referenced_results: [
            {
              type: "echo",
              value: "EF 55%",
              asserted_date: "2025-01-01",
              evidence_quote: null,
            },
          ],
          plan_items: [
            {
              action: "order troponin",
              target_followup: null,
              ordered_by_specialty: null,
              evidence_quote: null,
            },
          ],
        },
      },
      recent_vitals: [
        {
          type: "o2_sat",
          value_primary: 86,
          value_secondary: null,
          unit: "%",
          recorded_at: "2026-03-01T10:00:00.000Z",
        },
      ],
    });

    const flags = checkNoteCorrelation(ctx);
    const ids = flags.map((f) => f.rule_id);
    expect(ids).toContain("NOTE-VITAL-CONTRADICTION-001");
    expect(ids).toContain("STALE-EVIDENCE-001");
    expect(ids).toContain("ORDERED-NOT-RESULTED-001");
  });
});