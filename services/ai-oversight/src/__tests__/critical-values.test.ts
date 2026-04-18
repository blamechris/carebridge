import { describe, it, expect, vi } from "vitest";

// Mock workspace dependencies before importing the module under test.
vi.mock("@carebridge/shared-types", () => ({
  COMMON_LAB_TESTS: {
    Potassium: { unit: "mEq/L", typical_low: 3.5, typical_high: 5.0 },
    Troponin: { unit: "ng/mL", typical_low: 0, typical_high: 0.04 },
    WBC: { unit: "K/uL", typical_low: 4.5, typical_high: 11.0 },
    Hemoglobin: { unit: "g/dL", typical_low: 12.0, typical_high: 17.5 },
  },
}));

vi.mock("@carebridge/medical-logic", () => {
  const VITAL_DANGER_ZONES: Record<
    string,
    {
      min: number;
      max: number;
      criticalLow?: number;
      criticalHigh?: number;
      warningLow?: number;
      warningHigh?: number;
    }
  > = {
    heart_rate: { min: 20, max: 300, criticalLow: 40, criticalHigh: 200 },
    o2_sat: { min: 50, max: 100, criticalLow: 85 },
    temperature: { min: 85, max: 115, criticalLow: 95, criticalHigh: 104 },
    blood_pressure: {
      min: 60,
      max: 250,
      criticalLow: 55,
      criticalHigh: 180,
      warningLow: 90,
    },
    blood_glucose: {
      min: 10,
      max: 800,
      criticalLow: 50,
      criticalHigh: 350,
      warningLow: 70,
      warningHigh: 250,
    },
    respiratory_rate: {
      min: 4,
      max: 60,
      criticalLow: 8,
      criticalHigh: 40,
      warningLow: 12,
      warningHigh: 24,
    },
  };
  return {
    VITAL_DANGER_ZONES,
    DIASTOLIC_DANGER_ZONE: {
      criticalLow: 60,
      criticalHigh: 120,
      warningHigh: 90,
    },
    isCriticalVital: (type: string, value: number) => {
      const zone = VITAL_DANGER_ZONES[type];
      if (!zone) return false;
      if (zone.criticalLow !== undefined && value <= zone.criticalLow)
        return true;
      if (zone.criticalHigh !== undefined && value >= zone.criticalHigh)
        return true;
      return false;
    },
    checkDiastolicBP: (diastolic: number) => {
      if (diastolic < 60) return "critical";
      if (diastolic >= 120) return "critical";
      if (diastolic >= 90) return "warning";
      return null;
    },
    checkSystolicBP: (systolic: number) => {
      if (systolic <= 55) return "critical";
      if (systolic >= 180) return "critical";
      if (systolic < 90) return "warning";
      return null;
    },
    ageInYearsFromDOB: (dob: string | undefined | null) => {
      if (!dob) return undefined;
      const d = new Date(dob);
      if (isNaN(d.getTime())) return undefined;
      const diffMs = Date.now() - d.getTime();
      if (diffMs < 0) return undefined;
      return diffMs / (365.25 * 24 * 60 * 60 * 1000);
    },
    getVitalRangeForAge: (vitalType: string) => {
      return VITAL_DANGER_ZONES[vitalType] ?? { min: 0, max: 1000 };
    },
  };
});

import { checkCriticalValues, CRITICAL_LAB_THRESHOLDS } from "../rules/critical-values.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ─── Helper ──────────────────────────────────────────────────────
function makeVitalEvent(
  overrides: Partial<ClinicalEvent["data"]> & { type: string },
): ClinicalEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: "vital.created",
    patient_id: "p-test",
    data: overrides,
    timestamp: new Date().toISOString(),
  };
}

function makeLabEvent(
  results: Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
): ClinicalEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: "lab.resulted",
    patient_id: "p-test",
    data: { results, ...extra },
    timestamp: new Date().toISOString(),
  };
}

// ─── Null / Missing Value Safety ─────────────────────────────────
describe("checkCriticalValues — null and missing value safety", () => {
  it("returns empty flags when vital value_primary is undefined", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "heart_rate", value_primary: undefined }),
    );
    expect(flags).toHaveLength(0);
  });

  it("returns empty flags when vital type is undefined", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: undefined as unknown as string, value_primary: 210 }),
    );
    expect(flags).toHaveLength(0);
  });

  it("returns empty flags when lab results array is undefined", () => {
    const flags = checkCriticalValues({
      id: "evt-null-lab",
      type: "lab.resulted",
      patient_id: "p-test",
      data: {},
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });

  it("returns empty flags when lab results array is empty", () => {
    const flags = checkCriticalValues(makeLabEvent([]));
    expect(flags).toHaveLength(0);
  });

  it("handles unrecognized event type gracefully", () => {
    const flags = checkCriticalValues({
      id: "evt-unknown",
      type: "note.created" as ClinicalEvent["type"],
      patient_id: "p-test",
      data: { type: "heart_rate", value_primary: 999 },
      timestamp: new Date().toISOString(),
    });
    expect(flags).toHaveLength(0);
  });

  it("returns empty when blood_pressure has no value_secondary (diastolic)", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "blood_pressure", value_primary: 120 }),
    );
    // No diastolic flag should be emitted when value_secondary is missing.
    const diastolicFlag = flags.find(
      (f) => f.rule_id === "CRITICAL-VITAL-DIASTOLIC_BP",
    );
    expect(diastolicFlag).toBeUndefined();
  });
});

// ─── Vital Threshold Detection ───────────────────────────────────
describe("checkCriticalValues — vital threshold detection", () => {
  it("flags critically high temperature (>=104)", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "temperature", value_primary: 105, unit: "F" }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-VITAL-TEMPERATURE");
    expect(flags[0]!.summary).toContain("high");
  });

  it("flags critically low temperature (<=95)", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "temperature", value_primary: 93, unit: "F" }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("low");
  });

  it("returns empty for normal temperature (97)", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "temperature", value_primary: 97, unit: "F" }),
    );
    expect(flags).toHaveLength(0);
  });

  it("flags warning for respiratory rate outside warning range", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({
        type: "respiratory_rate",
        value_primary: 28,
        unit: "breaths/min",
      }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("CRITICAL-VITAL-RESPIRATORY_RATE");
  });

  it("flags critical respiratory rate (>=40)", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({
        type: "respiratory_rate",
        value_primary: 42,
        unit: "breaths/min",
      }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
  });

  it("returns empty for unknown vital type with no danger zone", () => {
    const flags = checkCriticalValues(
      makeVitalEvent({ type: "pupil_response", value_primary: 3 }),
    );
    expect(flags).toHaveLength(0);
  });
});

// ─── Lab Heuristic Fallback ──────────────────────────────────────
describe("checkCriticalValues — lab heuristic fallback", () => {
  it("flags lab marked critical by analyzing laboratory", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Magnesium",
          value: 0.8,
          unit: "mg/dL",
          reference_low: 1.7,
          reference_high: 2.2,
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-MAGNESIUM");
  });

  it("flags lab far outside reference range (>2x deviation)", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Calcium",
          value: 15.0,
          unit: "mg/dL",
          reference_low: 8.5,
          reference_high: 10.5,
          // range = 2.0, so > 10.5 + 2.0 = 12.5 triggers
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("Calcium");
  });

  it("does not flag lab within 2x deviation of reference range", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Calcium",
          value: 11.5,
          unit: "mg/dL",
          reference_low: 8.5,
          reference_high: 10.5,
          // 11.5 < 10.5 + 2.0 = 12.5, not critical
        },
      ]),
    );
    expect(flags).toHaveLength(0);
  });

  it("falls back to COMMON_LAB_TESTS when no reference range provided", () => {
    // Hemoglobin typical_low=12.0, typical_high=17.5, range=5.5
    // Value < 12.0 - 5.5 = 6.5 triggers critical
    const flags = checkCriticalValues(
      makeLabEvent([{ test_name: "Hemoglobin", value: 5.0, unit: "g/dL" }]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-HEMOGLOBIN");
  });

  it("does not flag unknown lab with no reference and no COMMON_LAB_TESTS entry", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        { test_name: "Obscure Marker X", value: 999, unit: "U/L" },
      ]),
    );
    expect(flags).toHaveLength(0);
  });
});

// ─── Multiple Lab Results in One Event ───────────────────────────
describe("checkCriticalValues — multiple lab results", () => {
  it("flags multiple critical results in a single lab panel", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        { test_name: "Potassium", value: 7.0, unit: "mEq/L" },
        { test_name: "Troponin I", value: 2.0, unit: "ng/mL" },
        { test_name: "Lactate", value: 1.5, unit: "mmol/L" }, // normal
      ]),
    );
    // Potassium critical + Troponin critical = 2 flags
    expect(flags).toHaveLength(2);
    const ruleIds = flags.map((f) => f.rule_id);
    expect(ruleIds).toContain("CRITICAL-LAB-POTASSIUM");
    expect(ruleIds).toContain("CRITICAL-LAB-TROPONIN_I");
  });
});

// ─── INR context-dependent behavior ─────────────────────────────
describe("checkCriticalValues — INR medication context", () => {
  it("matches INR by LOINC code 6301-6", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        { test_name: "Prothrombin INR", test_code: "6301-6", value: 6.0, unit: "" },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-INR");
    expect(flags[0]!.severity).toBe("critical");
  });

  it("detects subtherapeutic INR with Coumadin (brand name)", () => {
    const flags = checkCriticalValues(
      makeLabEvent(
        [{ test_name: "INR", value: 1.2, unit: "" }],
        { active_medications: ["Coumadin 5mg daily"] },
      ),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("Subtherapeutic");
  });
});

// ─── Explicit threshold definition structure ─────────────────────
describe("CRITICAL_LAB_THRESHOLDS — structure validation", () => {
  it("every threshold definition has names, loinc_codes, and evaluate", () => {
    for (const [key, def] of Object.entries(CRITICAL_LAB_THRESHOLDS)) {
      expect(def.names.length).toBeGreaterThan(0);
      expect(def.loinc_codes.length).toBeGreaterThan(0);
      expect(typeof def.evaluate).toBe("function");
    }
  });

  it("evaluate returns null for normal values (boundary testing)", () => {
    // Potassium normal range: 3.5-5.0
    const kResult = CRITICAL_LAB_THRESHOLDS["POTASSIUM"]!.evaluate(4.0);
    expect(kResult).toBeNull();

    // Troponin normal: <= 0.04
    const tropResult = CRITICAL_LAB_THRESHOLDS["TROPONIN_I"]!.evaluate(0.02);
    expect(tropResult).toBeNull();

    // Lactate normal: <= 2.0
    const lacResult = CRITICAL_LAB_THRESHOLDS["LACTATE"]!.evaluate(1.5);
    expect(lacResult).toBeNull();

    // pH normal: 7.35-7.45
    const phResult = CRITICAL_LAB_THRESHOLDS["PH_ARTERIAL"]!.evaluate(7.40);
    expect(phResult).toBeNull();

    // INR normal (no warfarin context): 1.5-4.0
    const inrResult = CRITICAL_LAB_THRESHOLDS["INR"]!.evaluate(2.5);
    expect(inrResult).toBeNull();
  });

  it("threshold evaluate returns correct severity and direction", () => {
    const criticalHigh = CRITICAL_LAB_THRESHOLDS["POTASSIUM"]!.evaluate(6.5);
    expect(criticalHigh).not.toBeNull();
    expect(criticalHigh!.severity).toBe("critical");
    expect(criticalHigh!.direction).toBe("high");

    const criticalLow = CRITICAL_LAB_THRESHOLDS["POTASSIUM"]!.evaluate(2.0);
    expect(criticalLow).not.toBeNull();
    expect(criticalLow!.severity).toBe("critical");
    expect(criticalLow!.direction).toBe("low");

    const warningHigh = CRITICAL_LAB_THRESHOLDS["POTASSIUM"]!.evaluate(5.5);
    expect(warningHigh).not.toBeNull();
    expect(warningHigh!.severity).toBe("warning");
    expect(warningHigh!.direction).toBe("high");
  });
});
