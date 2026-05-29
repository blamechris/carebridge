import { describe, it, expect } from "vitest";
import {
  detectReadmissionTrajectory,
  detectDischargeReadinessRisk,
  detectCrossSpecialtySymptomOrphan,
  type PriorEncounter,
  type CurrentEncounter,
  type LabTrend,
  type ConsultRequest,
  type DischargeSignal,
  type SymptomObservation,
} from "../deterioration-patterns.js";

// ─── READMISSION-TRAJECTORY ─────────────────────────────────────

describe("detectReadmissionTrajectory", () => {
  const currentEncounter: CurrentEncounter = {
    encounter_id: "enc-current",
    admitted_at: "2026-05-15T10:00:00Z",
  };

  it("does not fire when there are no prior encounters", () => {
    const result = detectReadmissionTrajectory({
      prior_encounters: [],
      current_encounter: currentEncounter,
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire when prior encounters are outside the lookback window", () => {
    const farPrior: PriorEncounter = {
      encounter_id: "enc-old",
      admitted_at: "2025-01-01T10:00:00Z",
      discharged_at: "2025-01-08T10:00:00Z",
      chief_complaint: "shortness of breath",
    };
    const result = detectReadmissionTrajectory({
      prior_encounters: [farPrior],
      current_encounter: currentEncounter,
      lookback_days: 90,
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire when prior encounter is in window but no labs trend the wrong way", () => {
    const prior: PriorEncounter = {
      encounter_id: "enc-recent",
      admitted_at: "2026-04-10T10:00:00Z",
      discharged_at: "2026-04-15T10:00:00Z",
      chief_complaint: "pneumonia",
    };
    const labTrends: LabTrend[] = [
      {
        lab_name: "creatinine",
        values: [
          { value: 1.0, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-recent" },
          { value: 0.9, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectReadmissionTrajectory({
      prior_encounters: [prior],
      current_encounter: currentEncounter,
      lab_trends: labTrends,
    });
    expect(result.fired).toBe(false);
  });

  it("fires when a rising-concern lab (creatinine) trends up across admissions", () => {
    const prior: PriorEncounter = {
      encounter_id: "enc-prior",
      admitted_at: "2026-04-10T10:00:00Z",
      discharged_at: "2026-04-15T10:00:00Z",
      chief_complaint: "AKI on dehydration",
    };
    const labTrends: LabTrend[] = [
      {
        lab_name: "creatinine",
        values: [
          { value: 1.1, unit: "mg/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
          { value: 1.8, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectReadmissionTrajectory({
      prior_encounters: [prior],
      current_encounter: currentEncounter,
      lab_trends: labTrends,
    });
    expect(result.fired).toBe(true);
    expect(result.summary).toContain("creatinine");
    expect(result.summary).toContain("1.1");
    expect(result.summary).toContain("1.8");
    expect(result.details?.worsening_labs).toBeDefined();
  });

  it("fires on a falling-concern lab (hemoglobin) trending down across admissions", () => {
    const prior: PriorEncounter = {
      encounter_id: "enc-prior-anemia",
      admitted_at: "2026-04-10T10:00:00Z",
      discharged_at: "2026-04-15T10:00:00Z",
      chief_complaint: "anemia workup",
    };
    const labTrends: LabTrend[] = [
      {
        lab_name: "hemoglobin",
        values: [
          { value: 11.2, unit: "g/dL", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior-anemia" },
          { value: 9.4, unit: "g/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectReadmissionTrajectory({
      prior_encounters: [prior],
      current_encounter: currentEncounter,
      lab_trends: labTrends,
    });
    expect(result.fired).toBe(true);
    expect(result.summary).toContain("hemoglobin");
  });

  it("fails closed (does not fire) when units differ across admissions", () => {
    const prior: PriorEncounter = {
      encounter_id: "enc-prior",
      admitted_at: "2026-04-10T10:00:00Z",
      chief_complaint: "AKI",
    };
    const labTrends: LabTrend[] = [
      {
        lab_name: "creatinine",
        values: [
          { value: 100, unit: "umol/L", measured_at: "2026-04-14T08:00:00Z", encounter_id: "enc-prior" },
          { value: 1.8, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectReadmissionTrajectory({
      prior_encounters: [prior],
      current_encounter: currentEncounter,
      lab_trends: labTrends,
    });
    expect(result.fired).toBe(false);
  });

  it("counts admissions in window correctly when multiple priors present", () => {
    const priors: PriorEncounter[] = [
      { encounter_id: "enc-1", admitted_at: "2026-03-01T10:00:00Z", chief_complaint: "x" },
      { encounter_id: "enc-2", admitted_at: "2026-04-10T10:00:00Z", chief_complaint: "x" },
    ];
    const labTrends: LabTrend[] = [
      {
        lab_name: "creatinine",
        values: [
          { value: 1.0, unit: "mg/dL", measured_at: "2026-03-04T08:00:00Z", encounter_id: "enc-1" },
          { value: 1.3, unit: "mg/dL", measured_at: "2026-04-13T08:00:00Z", encounter_id: "enc-2" },
          { value: 2.0, unit: "mg/dL", measured_at: "2026-05-15T12:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectReadmissionTrajectory({
      prior_encounters: priors,
      current_encounter: currentEncounter,
      lab_trends: labTrends,
    });
    expect(result.fired).toBe(true);
    expect(result.details?.admissions_in_window).toBe(2);
    expect(result.summary).toContain("Admission 3");
  });
});

// ─── DISCHARGE-READINESS ─────────────────────────────────────────

describe("detectDischargeReadinessRisk", () => {
  const dischargeSignal: DischargeSignal = {
    is_discharge_imminent: true,
    detected_at: "2026-05-15T18:00:00Z",
    source: "note_template",
  };

  it("does not fire when discharge is not imminent", () => {
    const result = detectDischargeReadinessRisk({
      discharge_signal: { ...dischargeSignal, is_discharge_imminent: false },
      consult_requests: [
        { consult_id: "c1", requested_at: "2026-05-13T10:00:00Z", specialty: "cardiology" },
      ],
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire on discharge with no concerning signals", () => {
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      consult_requests: [],
      recent_symptoms: [],
    });
    expect(result.fired).toBe(false);
  });

  it("fires when discharge is imminent and a lab is trending wrong in the current encounter", () => {
    const trends: LabTrend[] = [
      {
        lab_name: "lactate",
        values: [
          { value: 1.5, unit: "mmol/L", measured_at: "2026-05-15T08:00:00Z", encounter_id: "enc-current" },
          { value: 2.4, unit: "mmol/L", measured_at: "2026-05-15T17:00:00Z", encounter_id: "enc-current" },
        ],
      },
    ];
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      lab_trends: trends,
      current_encounter_id: "enc-current",
    });
    expect(result.fired).toBe(true);
    expect(result.summary?.toLowerCase()).toContain("lactate");
  });

  it("fires when a consult requested ≥24h ago has no closing note", () => {
    const consults: ConsultRequest[] = [
      {
        consult_id: "c1",
        requested_at: "2026-05-13T10:00:00Z", // ~56h before discharge signal
        specialty: "cardiology",
      },
    ];
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      consult_requests: consults,
    });
    expect(result.fired).toBe(true);
    expect(result.summary?.toLowerCase()).toContain("consult");
    expect(result.summary?.toLowerCase()).toContain("cardiology");
  });

  it("does not count consults that have been responded to", () => {
    const consults: ConsultRequest[] = [
      {
        consult_id: "c1",
        requested_at: "2026-05-13T10:00:00Z",
        specialty: "cardiology",
        responded_at: "2026-05-14T11:00:00Z",
        closed_by_note_id: "note-1",
      },
    ];
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      consult_requests: consults,
    });
    expect(result.fired).toBe(false);
  });

  it("fires when recent unresolved symptoms are present", () => {
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      recent_symptoms: ["new chest pain", "worsening dyspnea"],
    });
    expect(result.fired).toBe(true);
    expect(result.summary?.toLowerCase()).toContain("chest pain");
  });

  it("composes multiple reasons in the summary when several signals fire", () => {
    const result = detectDischargeReadinessRisk({
      discharge_signal: dischargeSignal,
      consult_requests: [
        { consult_id: "c1", requested_at: "2026-05-13T10:00:00Z", specialty: "endocrinology" },
      ],
      recent_symptoms: ["altered mental status"],
    });
    expect(result.fired).toBe(true);
    expect(result.summary?.toLowerCase()).toContain("consult");
    expect(result.summary?.toLowerCase()).toContain("altered mental status");
  });
});

// ─── CROSS-SPECIALTY-SYMPTOM-ORPHAN ─────────────────────────────

describe("detectCrossSpecialtySymptomOrphan", () => {
  it("does not fire when only one specialty documented a symptom", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({ symptom_observations: observations });
    expect(result.fired).toBe(false);
  });

  it("does not fire when multiple specialties documented but at least one owned the workup", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: true,
      },
      {
        symptom: "dyspnea",
        documented_by_specialty: "cardiology",
        documented_at: "2026-05-15T10:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({ symptom_observations: observations });
    expect(result.fired).toBe(false);
  });

  it("fires when a symptom is documented across ≥2 specialties with no workup", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: false,
      },
      {
        symptom: "dyspnea",
        documented_by_specialty: "cardiology",
        documented_at: "2026-05-15T10:00:00Z",
        has_workup: false,
      },
      {
        symptom: "dyspnea",
        documented_by_specialty: "ICU",
        documented_at: "2026-05-15T14:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({ symptom_observations: observations });
    expect(result.fired).toBe(true);
    expect(result.summary?.toLowerCase()).toContain("dyspnea");
    expect(result.summary?.toLowerCase()).toContain("pulmonology");
    expect(result.summary?.toLowerCase()).toContain("cardiology");
  });

  it("normalizes symptom names (case-insensitive, trimmed)", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "Dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: false,
      },
      {
        symptom: "  dyspnea  ",
        documented_by_specialty: "cardiology",
        documented_at: "2026-05-15T10:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({ symptom_observations: observations });
    expect(result.fired).toBe(true);
  });

  it("respects min_specialties override", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: false,
      },
      {
        symptom: "dyspnea",
        documented_by_specialty: "cardiology",
        documented_at: "2026-05-15T10:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({
      symptom_observations: observations,
      min_specialties: 3,
    });
    expect(result.fired).toBe(false);
  });

  it("returns multiple orphaned symptoms in details when several patterns fire", () => {
    const observations: SymptomObservation[] = [
      {
        symptom: "dyspnea",
        documented_by_specialty: "pulmonology",
        documented_at: "2026-05-15T08:00:00Z",
        has_workup: false,
      },
      {
        symptom: "dyspnea",
        documented_by_specialty: "cardiology",
        documented_at: "2026-05-15T10:00:00Z",
        has_workup: false,
      },
      {
        symptom: "confusion",
        documented_by_specialty: "neurology",
        documented_at: "2026-05-15T11:00:00Z",
        has_workup: false,
      },
      {
        symptom: "confusion",
        documented_by_specialty: "ICU",
        documented_at: "2026-05-15T13:00:00Z",
        has_workup: false,
      },
    ];
    const result = detectCrossSpecialtySymptomOrphan({ symptom_observations: observations });
    expect(result.fired).toBe(true);
    const orphaned = result.details?.orphaned_symptoms as Array<{ symptom: string }>;
    expect(orphaned).toHaveLength(2);
    expect(orphaned.map((o) => o.symptom).sort()).toEqual(["confusion", "dyspnea"]);
  });
});
