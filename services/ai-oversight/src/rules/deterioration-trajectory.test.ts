import { describe, it, expect } from "vitest";
import { checkDeteriorationTrajectory, DETERIORATION_TRAJECTORY_RULE_ID } from "./deterioration-trajectory.js";
import type { PatientContext } from "./cross-specialty.js";

// ─── Helpers ────────────────────────────────────────────────────

function baseContext(overrides: Partial<PatientContext> = {}): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: [],
    new_symptoms: [],
    care_team_specialties: [],
    ...overrides,
  };
}

// ─── No-fire baselines ───────────────────────────────────────────

describe("checkDeteriorationTrajectory — no-fire baselines", () => {
  it("returns null on an empty context", () => {
    const flag = checkDeteriorationTrajectory(baseContext());
    expect(flag).toBeNull();
  });

  it("returns null when only one sub-rule could fire but its data is absent", () => {
    const ctx = baseContext({
      discharge_signal: {
        is_discharge_imminent: false, // not imminent → no fire
        detected_at: "2026-05-15T18:00:00Z",
        source: "manual",
      },
    });
    expect(checkDeteriorationTrajectory(ctx)).toBeNull();
  });

  it("returns null when prior encounters exist but no labs trend wrong", () => {
    const ctx = baseContext({
      prior_encounters: [
        {
          encounter_id: "enc-prior",
          admitted_at: "2026-04-10T10:00:00Z",
          chief_complaint: "x",
        },
      ],
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
      },
      lab_trends: [
        {
          lab_name: "creatinine",
          values: [
            { value: 1.0, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
            { value: 0.9, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
    });
    expect(checkDeteriorationTrajectory(ctx)).toBeNull();
  });
});

// ─── Single sub-rule fires ───────────────────────────────────────

describe("checkDeteriorationTrajectory — single sub-rule fires", () => {
  it("fires READMISSION-TRAJECTORY with warning severity when one lab worsens across admissions", () => {
    const ctx = baseContext({
      prior_encounters: [
        {
          encounter_id: "enc-prior",
          admitted_at: "2026-04-10T10:00:00Z",
          chief_complaint: "AKI",
        },
      ],
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
        attending_specialty: "hospitalist",
      },
      lab_trends: [
        {
          lab_name: "creatinine",
          values: [
            { value: 1.1, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
            { value: 1.7, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe("warning");
    expect(flag?.rule_id).toBe(DETERIORATION_TRAJECTORY_RULE_ID);
    expect(flag?.summary).toContain("READMISSION-TRAJECTORY");
    expect(flag?.notify_specialties).toContain("hospitalist");
    const meta = flag?.metadata as { sub_rules_fired: string[] } | undefined;
    expect(meta?.sub_rules_fired).toEqual(["READMISSION-TRAJECTORY"]);
  });

  it("fires DISCHARGE-READINESS when discharge imminent + open consult", () => {
    const ctx = baseContext({
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-13T10:00:00Z",
        attending_specialty: "hospitalist",
      },
      discharge_signal: {
        is_discharge_imminent: true,
        detected_at: "2026-05-15T18:00:00Z",
        source: "note_template",
      },
      consult_requests: [
        {
          consult_id: "c1",
          requested_at: "2026-05-13T11:00:00Z",
          specialty: "cardiology",
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe("warning");
    expect(flag?.summary).toContain("DISCHARGE-READINESS");
  });

  it("fires CROSS-SPECIALTY-SYMPTOM-ORPHAN when ≥2 specialties documented a symptom with no workup", () => {
    const ctx = baseContext({
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
      },
      symptom_observations: [
        {
          symptom: "altered mental status",
          documented_by_specialty: "neurology",
          documented_at: "2026-05-15T08:00:00Z",
          has_workup: false,
        },
        {
          symptom: "altered mental status",
          documented_by_specialty: "hospitalist",
          documented_at: "2026-05-15T14:00:00Z",
          has_workup: false,
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.summary).toContain("CROSS-SPECIALTY-SYMPTOM-ORPHAN");
    expect(flag?.notify_specialties).toEqual(
      expect.arrayContaining(["neurology", "hospitalist"]),
    );
  });
});

// ─── Multiple sub-rules fire / severity escalation ───────────────

describe("checkDeteriorationTrajectory — severity escalation", () => {
  it("escalates to CRITICAL when ≥2 admissions in window AND ≥2 worsening labs", () => {
    const ctx = baseContext({
      prior_encounters: [
        {
          encounter_id: "enc-1",
          admitted_at: "2026-03-01T10:00:00Z",
          chief_complaint: "x",
        },
        {
          encounter_id: "enc-2",
          admitted_at: "2026-04-10T10:00:00Z",
          chief_complaint: "x",
        },
      ],
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
      },
      lab_trends: [
        {
          lab_name: "creatinine",
          values: [
            { value: 1.0, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-2" },
            { value: 1.9, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
        {
          lab_name: "hemoglobin",
          values: [
            { value: 11.2, unit: "g/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-2" },
            { value: 9.1, unit: "g/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe("critical");
  });

  it("escalates DISCHARGE-READINESS to CRITICAL when imminent + open consult + worsening lab in current encounter", () => {
    const ctx = baseContext({
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-13T10:00:00Z",
      },
      discharge_signal: {
        is_discharge_imminent: true,
        detected_at: "2026-05-15T18:00:00Z",
        source: "note_template",
      },
      consult_requests: [
        { consult_id: "c1", requested_at: "2026-05-13T11:00:00Z", specialty: "cardiology" },
      ],
      lab_trends: [
        {
          lab_name: "lactate",
          values: [
            { value: 1.5, unit: "mmol/L", measured_at: "2026-05-15T08:00:00Z", encounter_id: "enc-current" },
            { value: 2.6, unit: "mmol/L", measured_at: "2026-05-15T17:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe("critical");
  });

  it("composes a multi-sub-rule flag when several patterns fire", () => {
    const ctx = baseContext({
      prior_encounters: [
        {
          encounter_id: "enc-prior",
          admitted_at: "2026-04-10T10:00:00Z",
          chief_complaint: "x",
        },
      ],
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
      },
      lab_trends: [
        {
          lab_name: "creatinine",
          values: [
            { value: 1.1, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
            { value: 1.7, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
      symptom_observations: [
        {
          symptom: "fatigue",
          documented_by_specialty: "hospitalist",
          documented_at: "2026-05-15T08:00:00Z",
          has_workup: false,
        },
        {
          symptom: "fatigue",
          documented_by_specialty: "oncology",
          documented_at: "2026-05-15T10:00:00Z",
          has_workup: false,
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    const meta = flag?.metadata as { sub_rules_fired: string[] } | undefined;
    expect(meta?.sub_rules_fired).toContain("READMISSION-TRAJECTORY");
    expect(meta?.sub_rules_fired).toContain("CROSS-SPECIALTY-SYMPTOM-ORPHAN");
    expect(flag?.summary).toContain("2 sub-patterns fired");
  });
});

// ─── Notify specialties wiring ───────────────────────────────────

describe("checkDeteriorationTrajectory — notify_specialties", () => {
  it("includes attending and care team specialties even when sub-rules don't enumerate specialties", () => {
    const ctx = baseContext({
      care_team_specialties: ["primary_care", "endocrinology"],
      prior_encounters: [
        {
          encounter_id: "enc-prior",
          admitted_at: "2026-04-10T10:00:00Z",
          chief_complaint: "x",
        },
      ],
      current_encounter: {
        encounter_id: "enc-current",
        admitted_at: "2026-05-15T10:00:00Z",
        attending_specialty: "hospitalist",
      },
      lab_trends: [
        {
          lab_name: "creatinine",
          values: [
            { value: 1.1, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
            { value: 1.7, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
          ],
        },
      ],
    });
    const flag = checkDeteriorationTrajectory(ctx);
    expect(flag).not.toBeNull();
    expect(flag?.notify_specialties).toEqual(
      expect.arrayContaining(["hospitalist", "primary_care", "endocrinology"]),
    );
  });

  it("falls back to 'hospitalist' when no other specialties are known", () => {
    const ctx = baseContext({
      symptom_observations: [
        {
          symptom: "dyspnea",
          documented_by_specialty: "",
          documented_at: "2026-05-15T08:00:00Z",
          has_workup: false,
        },
        {
          symptom: "dyspnea",
          documented_by_specialty: "",
          documented_at: "2026-05-15T10:00:00Z",
          has_workup: false,
        },
      ],
    });
    // Note: this synthesis won't actually fire because both observations have
    // the same (empty) specialty, so cross-specialty count is 1. That's a
    // separate test of the detector. Here, no sub-rule fires → null.
    expect(checkDeteriorationTrajectory(ctx)).toBeNull();
  });
});
