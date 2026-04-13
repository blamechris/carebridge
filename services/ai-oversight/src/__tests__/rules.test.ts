import { describe, it, expect, vi } from "vitest";

// Mock the workspace dependencies before importing the rules
vi.mock("@carebridge/shared-types", () => ({
  COMMON_LAB_TESTS: {
    Potassium: { unit: "mEq/L", typical_low: 3.5, typical_high: 5.0 },
    Troponin: { unit: "ng/mL", typical_low: 0, typical_high: 0.04 },
    WBC: { unit: "K/uL", typical_low: 4.5, typical_high: 11.0 },
  },
}));

vi.mock("@carebridge/medical-logic", () => {
  const VITAL_DANGER_ZONES: Record<string, { min: number; max: number; criticalLow?: number; criticalHigh?: number; warningLow?: number; warningHigh?: number }> = {
    heart_rate: { min: 20, max: 300, criticalLow: 40, criticalHigh: 200 },
    o2_sat: { min: 50, max: 100, criticalLow: 85 },
    temperature: { min: 85, max: 115, criticalLow: 95, criticalHigh: 104 },
    blood_pressure: { min: 60, max: 250, criticalLow: 70, criticalHigh: 180 },
    blood_glucose: { min: 10, max: 800, criticalLow: 50, criticalHigh: 350, warningLow: 70, warningHigh: 250 },
  };
  return {
    VITAL_DANGER_ZONES,
    DIASTOLIC_DANGER_ZONE: {
      criticalLow: 60,
      criticalHigh: 120,
      warningHigh: 90,
    },
    isCriticalVital: (type: string, value: number, _ageYears?: number) => {
      const zone = VITAL_DANGER_ZONES[type];
      if (!zone) return false;
      if (zone.criticalLow !== undefined && value <= zone.criticalLow) return true;
      if (zone.criticalHigh !== undefined && value >= zone.criticalHigh) return true;
      return false;
    },
    getVitalSeverity: (type: string, value: number) => {
      const zone = VITAL_DANGER_ZONES[type];
      if (!zone) return null;
      if (zone.criticalLow !== undefined && value <= zone.criticalLow) return "critical";
      if (zone.criticalHigh !== undefined && value >= zone.criticalHigh) return "critical";
      if (zone.warningLow !== undefined && value < zone.warningLow) return "warning";
      if (zone.warningHigh !== undefined && value > zone.warningHigh) return "warning";
      return null;
    },
    checkDiastolicBP: (diastolic: number) => {
      if (diastolic < 60) return "critical";
      if (diastolic >= 120) return "critical";
      if (diastolic >= 90) return "warning";
      return null;
    },
    ageInYearsFromDOB: (dob: string | undefined | null, refDate?: Date) => {
      if (!dob) return undefined;
      const d = new Date(dob);
      if (isNaN(d.getTime())) return undefined;
      const ref = refDate ?? new Date();
      const diffMs = ref.getTime() - d.getTime();
      if (diffMs < 0) return undefined;
      return diffMs / (365.25 * 24 * 60 * 60 * 1000);
    },
    getVitalRangeForAge: (vitalType: string, _ageYears?: number) => {
      return VITAL_DANGER_ZONES[vitalType] ?? { min: 0, max: 1000 };
    },
  };
});

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns, type PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";

describe("checkCriticalValues", () => {
  it("flags critically high heart rate", () => {
    const flags = checkCriticalValues({
      id: "evt-1",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "heart_rate", value_primary: 210, unit: "bpm" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.category).toBe("critical-value");
    expect(flags[0]!.rule_id).toBe("CRITICAL-VITAL-HEART_RATE");
  });

  it("flags critically low O2 saturation", () => {
    const flags = checkCriticalValues({
      id: "evt-2",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "o2_sat", value_primary: 80, unit: "%" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("low");
  });

  it("returns empty for normal vital values", () => {
    const flags = checkCriticalValues({
      id: "evt-3",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "heart_rate", value_primary: 72, unit: "bpm" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(0);
  });

  it("flags glucose 45 as critical (severe hypoglycemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-glu-1",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_glucose", value_primary: 45, unit: "mg/dL" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("low");
  });

  it("flags glucose 65 as warning (mild hypoglycemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-glu-2",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_glucose", value_primary: 65, unit: "mg/dL" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("Low");
  });

  it("returns empty for normal glucose 120", () => {
    const flags = checkCriticalValues({
      id: "evt-glu-3",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_glucose", value_primary: 120, unit: "mg/dL" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(0);
  });

  it("flags glucose 300 as warning (hyperglycemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-glu-4",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_glucose", value_primary: 300, unit: "mg/dL" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("High");
  });

  it("flags glucose 450 as critical (DKA territory)", () => {
    const flags = checkCriticalValues({
      id: "evt-glu-5",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_glucose", value_primary: 450, unit: "mg/dL" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("high");
  });

  it("returns no diastolic flag for normal BP (120/80)", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-1",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 120, value_secondary: 80, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(0);
  });

  it("flags systolic crisis (190/90) as critical", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-2",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 190, value_secondary: 90, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    // Systolic 190 >= 180 triggers systolic critical flag
    const systolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-BLOOD_PRESSURE");
    expect(systolicFlag).toBeDefined();
    expect(systolicFlag!.severity).toBe("critical");
  });

  it("flags diastolic crisis (145/125) as critical — hypertensive emergency", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-3",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 145, value_secondary: 125, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    // Systolic 145 is NOT critical (< 180), but diastolic 125 >= 120 is critical
    const systolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-BLOOD_PRESSURE");
    expect(systolicFlag).toBeUndefined();

    const diastolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-DIASTOLIC_BP");
    expect(diastolicFlag).toBeDefined();
    expect(diastolicFlag!.severity).toBe("critical");
    expect(diastolicFlag!.summary).toContain("diastolic");
    expect(diastolicFlag!.summary).toContain("145/125");
  });

  it("flags both systolic and diastolic when both critical (200/130)", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-4",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 200, value_secondary: 130, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    const systolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-BLOOD_PRESSURE");
    expect(systolicFlag).toBeDefined();
    expect(systolicFlag!.severity).toBe("critical");

    const diastolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-DIASTOLIC_BP");
    expect(diastolicFlag).toBeDefined();
    expect(diastolicFlag!.severity).toBe("critical");
  });

  it("flags isolated diastolic high (135/95) as warning", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-5",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 135, value_secondary: 95, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    // Systolic 135 is not critical
    const systolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-BLOOD_PRESSURE");
    expect(systolicFlag).toBeUndefined();

    // Diastolic 95 >= 90 triggers warning
    const diastolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-DIASTOLIC_BP");
    expect(diastolicFlag).toBeDefined();
    expect(diastolicFlag!.severity).toBe("warning");
  });

  it("flags critically low diastolic (130/50) as critical hypotension", () => {
    const flags = checkCriticalValues({
      id: "evt-bp-6",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "blood_pressure", value_primary: 130, value_secondary: 50, unit: "mmHg" },
      timestamp: new Date().toISOString(),
    });

    const diastolicFlag = flags.find((f) => f.rule_id === "CRITICAL-VITAL-DIASTOLIC_BP");
    expect(diastolicFlag).toBeDefined();
    expect(diastolicFlag!.severity).toBe("critical");
    expect(diastolicFlag!.summary).toContain("low");
  });

  it("flags critical lab results with explicit critical flag", () => {
    const flags = checkCriticalValues({
      id: "evt-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: {
        results: [
          {
            test_name: "WBC",
            value: 50.0,
            unit: "K/uL",
            reference_low: 4.5,
            reference_high: 11.0,
            flag: "critical",
          },
        ],
      },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-WBC");
  });
});

// ─── Explicit Critical Lab Thresholds ────────────────────────────

describe("checkCriticalValues — Troponin I thresholds", () => {
  it("flags troponin >0.4 as critical (MI range)", () => {
    const flags = checkCriticalValues({
      id: "evt-trop-1",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Troponin I", value: 1.2, unit: "ng/mL" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-TROPONIN_I");
    expect(flags[0]!.notify_specialties).toContain("cardiology");
  });

  it("flags troponin >0.04 as warning", () => {
    const flags = checkCriticalValues({
      id: "evt-trop-2",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Troponin", value: 0.15, unit: "ng/mL" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-TROPONIN_I");
  });

  it("does not flag normal troponin (<=0.04)", () => {
    const flags = checkCriticalValues({
      id: "evt-trop-3",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Troponin I", value: 0.02, unit: "ng/mL" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });

  it("matches troponin by LOINC code", () => {
    const flags = checkCriticalValues({
      id: "evt-trop-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Cardiac Troponin", test_code: "10839-9", value: 0.5, unit: "ng/mL" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-TROPONIN_I");
  });
});

describe("checkCriticalValues — Potassium thresholds", () => {
  it("flags potassium >=6.0 as critical (hyperkalemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-k-1",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Potassium", value: 7.2, unit: "mEq/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
    expect(flags[0]!.notify_specialties).toContain("nephrology");
  });

  it("flags potassium 5.1-5.9 as warning", () => {
    const flags = checkCriticalValues({
      id: "evt-k-2",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Potassium", value: 5.5, unit: "mEq/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
  });

  it("flags potassium <3.0 as critical (hypokalemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-k-3",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Potassium", value: 2.5, unit: "mEq/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("hypokalemia");
  });

  it("flags potassium 3.0-3.4 as warning (mild hypokalemia)", () => {
    const flags = checkCriticalValues({
      id: "evt-k-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Potassium", value: 3.2, unit: "mEq/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
  });

  it("does not flag normal potassium (3.5-5.0)", () => {
    const flags = checkCriticalValues({
      id: "evt-k-5",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Potassium", value: 4.2, unit: "mEq/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });
});

describe("checkCriticalValues — Lactate thresholds", () => {
  it("flags lactate >4.0 as critical (sepsis/shock)", () => {
    const flags = checkCriticalValues({
      id: "evt-lac-1",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Lactate", value: 6.5, unit: "mmol/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-LACTATE");
    expect(flags[0]!.notify_specialties).toContain("critical_care");
  });

  it("flags lactate >2.0 as warning", () => {
    const flags = checkCriticalValues({
      id: "evt-lac-2",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Lactic Acid", value: 3.0, unit: "mmol/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-LACTATE");
  });

  it("does not flag normal lactate (<=2.0)", () => {
    const flags = checkCriticalValues({
      id: "evt-lac-3",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Lactate", value: 1.5, unit: "mmol/L" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });
});

describe("checkCriticalValues — pH (arterial) thresholds", () => {
  it("flags pH <7.25 as critical (severe acidosis)", () => {
    const flags = checkCriticalValues({
      id: "evt-ph-1",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "pH (arterial)", value: 7.1, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-PH_ARTERIAL");
    expect(flags[0]!.summary).toContain("acidemia");
  });

  it("flags pH 7.25-7.34 as warning (acidosis)", () => {
    const flags = checkCriticalValues({
      id: "evt-ph-2",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "pH", value: 7.30, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-PH_ARTERIAL");
  });

  it("flags pH >7.55 as critical (severe alkalosis)", () => {
    const flags = checkCriticalValues({
      id: "evt-ph-3",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "Arterial pH", value: 7.62, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("alkalemia");
  });

  it("flags pH 7.45-7.55 as warning (alkalosis)", () => {
    const flags = checkCriticalValues({
      id: "evt-ph-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "pH", value: 7.50, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
  });

  it("does not flag normal pH (7.35-7.45)", () => {
    const flags = checkCriticalValues({
      id: "evt-ph-5",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "pH", value: 7.40, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });
});

describe("checkCriticalValues — INR thresholds", () => {
  it("flags INR >5.0 as critical (hemorrhage risk)", () => {
    const flags = checkCriticalValues({
      id: "evt-inr-1",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "INR", value: 6.5, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-INR");
    expect(flags[0]!.notify_specialties).toContain("hematology");
  });

  it("flags INR >4.0 as warning", () => {
    const flags = checkCriticalValues({
      id: "evt-inr-2",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "INR", value: 4.5, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-INR");
  });

  it("flags INR <1.5 as warning when on warfarin (subtherapeutic)", () => {
    const flags = checkCriticalValues({
      id: "evt-inr-3",
      type: "lab.resulted",
      patient_id: "p-1",
      data: {
        results: [{ test_name: "INR", value: 1.1, unit: "" }],
        active_medications: ["Warfarin 5mg daily"],
      },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("Subtherapeutic");
  });

  it("does not flag INR <1.5 when not on warfarin", () => {
    const flags = checkCriticalValues({
      id: "evt-inr-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: { results: [{ test_name: "INR", value: 1.1, unit: "" }] },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });

  it("does not flag normal therapeutic INR (2.0-3.0)", () => {
    const flags = checkCriticalValues({
      id: "evt-inr-5",
      type: "lab.resulted",
      patient_id: "p-1",
      data: {
        results: [{ test_name: "INR", value: 2.5, unit: "" }],
        active_medications: ["Warfarin 5mg daily"],
      },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });
});

describe("checkCrossSpecialtyPatterns", () => {
  it("flags DVT scenario: cancer + VTE + headache → stroke risk (ONCO-VTE-NEURO-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: [
        "Pancreatic adenocarcinoma",
        "Deep vein thrombosis, right lower extremity",
      ],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Enoxaparin 40mg SQ daily"],
      new_symptoms: ["New onset severe headache"],
      care_team_specialties: ["hematology", "oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeDefined();
    expect(dvtFlag!.severity).toBe("critical");
    expect(dvtFlag!.category).toBe("cross-specialty");
    expect(dvtFlag!.notify_specialties).toContain("neurology");
  });

  it("does not flag when only cancer + VTE but no neuro symptom", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Lung cancer", "DVT"],
      active_diagnosis_codes: ["C34.90", "I82.401"],
      active_medications: [],
      new_symptoms: ["nausea"],
      care_team_specialties: ["oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeUndefined();
  });

  it("returns empty for benign patient context", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Seasonal allergies"],
      active_diagnosis_codes: ["J30.1"],
      active_medications: ["Cetirizine 10mg"],
      new_symptoms: ["runny nose"],
      care_team_specialties: ["primary_care"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    expect(flags).toHaveLength(0);
  });

  it("flags anticoagulant + bleeding symptom (ANTICOAG-BLEED-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: [],
      active_diagnosis_codes: [],
      active_medications: ["Warfarin 5mg daily"],
      new_symptoms: ["blood in stool"],
      care_team_specialties: ["primary_care"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const bleedFlag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(bleedFlag).toBeDefined();
    expect(bleedFlag!.severity).toBe("critical");
  });
});


  it("flags anticoagulant held in VTE patient (ONCO-ANTICOAG-HELD-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis, left lower extremity"],
      active_diagnosis_codes: ["I82.402"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: ["hematology"],
      trigger_event: {
        id: "evt-held-1",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Enoxaparin 40mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeDefined();
    expect(heldFlag!.severity).toBe("critical");
    expect(heldFlag!.category).toBe("medication-safety");
  });

  it("does not flag non-anticoagulant held in VTE patient", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis"],
      active_diagnosis_codes: ["I82.401"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-held-2",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Metformin 500mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeUndefined();
  });

  it("does not flag anticoagulant held without VTE diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Hypertension"],
      active_diagnosis_codes: ["I10"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-held-3",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Warfarin 5mg", status: "discontinued" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeUndefined();
  });

  it("includes anticoag modifier in ONCO-VTE-NEURO-001 suggested action", () => {
    const ctxWithAnticoag: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Enoxaparin 40mg SQ daily"],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags = checkCrossSpecialtyPatterns(ctxWithAnticoag);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeDefined();
    expect(dvtFlag!.suggested_action).toContain("hemorrhagic risk");

    const ctxNoAnticoag: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags2 = checkCrossSpecialtyPatterns(ctxNoAnticoag);
    const dvtFlag2 = flags2.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag2).toBeDefined();
    expect(dvtFlag2!.suggested_action).toContain("NOT on anticoagulation");
  });
describe("checkDrugInteractions", () => {
  it("flags warfarin + NSAID interaction", () => {
    const flags = checkDrugInteractions(["Warfarin 5mg", "Ibuprofen 400mg"]);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const interaction = flags.find((f) => f.rule_id === "DI-WARFARIN-NSAID");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags SSRI + MAOI as contraindicated", () => {
    const flags = checkDrugInteractions(["Fluoxetine 20mg", "Phenelzine 15mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-SSRI-MAOI");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("returns empty for non-interacting medications", () => {
    const flags = checkDrugInteractions([
      "Acetaminophen 500mg",
      "Omeprazole 20mg",
      "Metformin 500mg",
    ]);

    expect(flags).toHaveLength(0);
  });

  it("does not flag the same medication against itself", () => {
    const flags = checkDrugInteractions(["Warfarin 5mg"]);

    const warfarinNsaid = flags.find((f) => f.rule_id === "DI-WARFARIN-NSAID");
    expect(warfarinNsaid).toBeUndefined();
  });

  it("flags clarithromycin + simvastatin as CRITICAL (contraindicated)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Simvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
    expect(interaction!.summary).toContain("rhabdomyolysis");
  });

  it("flags clarithromycin + lovastatin as CRITICAL (contraindicated)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Lovastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags erythromycin + simvastatin as CRITICAL", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Simvastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags erythromycin + lovastatin as CRITICAL", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Lovastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags clarithromycin + atorvastatin as WARNING (dose reduction needed)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Atorvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("warning");
    expect(interaction!.summary).toContain("dose reduction");
  });

  it("flags erythromycin + atorvastatin as WARNING", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Atorvastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("warning");
  });

  it("does NOT flag azithromycin + simvastatin (azithromycin is safe — minimal CYP3A4 inhibition)", () => {
    const flags = checkDrugInteractions(["Azithromycin 250mg", "Simvastatin 40mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("does NOT flag clarithromycin + pravastatin (pravastatin not CYP3A4-metabolized)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Pravastatin 40mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("does NOT flag clarithromycin + rosuvastatin (rosuvastatin not CYP3A4-metabolized)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Rosuvastatin 10mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("notifies cardiology and infectious_disease for macrolide-statin interactions", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Simvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction!.notify_specialties).toContain("cardiology");
    expect(interaction!.notify_specialties).toContain("infectious_disease");
  });
});
