import { describe, it, expect } from "vitest";
import {
  validateVital,
  validateMedicationDose,
  validateLabResult,
  isCriticalVital,
  getVitalSeverity,
  checkSystolicBP,
  VITAL_DANGER_ZONES,
  PEDIATRIC_VITAL_RANGES,
  classifyAgeGroup,
  ageInYearsFromDOB,
  getVitalRangeForAge,
} from "../medical-validation.js";

// ─── validateVital ──────────────────────────────────────────────

describe("validateVital", () => {
  it("returns valid for normal heart rate", () => {
    const result = validateVital("heart_rate", 72);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("flags heart rate outside plausible range as error", () => {
    const result = validateVital("heart_rate", 350);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("warns on critically high heart rate within plausible range", () => {
    const result = validateVital("heart_rate", 210);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Critically high");
  });

  it("warns on critically low O2 saturation", () => {
    const result = validateVital("o2_sat", 80);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Critically low");
  });

  it("errors on NaN value", () => {
    const result = validateVital("heart_rate", NaN);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toBe("Value must be a number");
  });

  it("validates blood pressure diastolic < systolic", () => {
    const result = validateVital("blood_pressure", 120, 130);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Diastolic");
  });

  it("validates blood pressure diastolic in range", () => {
    const result = validateVital("blood_pressure", 120, 10);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Diastolic") && e.includes("plausible"))).toBe(true);
  });

  it("returns valid for normal blood pressure", () => {
    const result = validateVital("blood_pressure", 120, 80);
    expect(result.valid).toBe(true);
  });

  it("warns on narrow pulse pressure (shock / tamponade)", () => {
    // 80/75 — PP=5, clinically suggests shock or artifact
    const result = validateVital("blood_pressure", 80, 75);
    expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
  });

  it("warns on wide pulse pressure (aortic regurgitation)", () => {
    // 140/20 — PP=120, suggests AR or measurement error
    // Note: diastolic 20 is at the lower plausibility bound but valid.
    const result = validateVital("blood_pressure", 140, 20);
    expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
  });

  it("does not warn on typical pulse pressure", () => {
    // 120/80 — PP=40, normal adult
    const result = validateVital("blood_pressure", 120, 80);
    expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
  });

  it("does not warn on pulse pressure when diastolic >= systolic (error already flagged)", () => {
    // Invariant: PP warning should not fire when the diastolic >= systolic
    // error is already flagged — no need to pile on.
    const result = validateVital("blood_pressure", 120, 130);
    expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
  });

  it("returns valid for temperature in normal range", () => {
    const result = validateVital("temperature", 98.6);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on critically high temperature (fever)", () => {
    const result = validateVital("temperature", 105);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ─── validateMedicationDose ─────────────────────────────────────

describe("validateMedicationDose", () => {
  it("returns valid for reasonable dose", () => {
    const result = validateMedicationDose(500, "mg");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns valid when dose is undefined", () => {
    const result = validateMedicationDose(undefined, undefined);
    expect(result.valid).toBe(true);
  });

  it("errors on negative dose", () => {
    const result = validateMedicationDose(-10, "mg");
    expect(result.valid).toBe(false);
  });

  it("errors on zero dose", () => {
    const result = validateMedicationDose(0, "mg");
    expect(result.valid).toBe(false);
  });

  it("errors on dose exceeding 10,000", () => {
    const result = validateMedicationDose(15000, "mg");
    expect(result.valid).toBe(false);
  });

  it("warns on unusually high mg dose", () => {
    const result = validateMedicationDose(6000, "mg");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("unusually high");
  });

  it("warns on unusually high mcg dose", () => {
    const result = validateMedicationDose(1500, "mcg");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns on unusually high mL dose", () => {
    const result = validateMedicationDose(600, "ml");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("errors on NaN dose", () => {
    const result = validateMedicationDose(NaN, "mg");
    expect(result.valid).toBe(false);
  });
});

// ─── validateLabResult ──────────────────────────────────────────

describe("validateLabResult", () => {
  it("returns valid for value in typical range", () => {
    const result = validateLabResult("WBC", 7.5, "K/uL");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on value below typical range", () => {
    const result = validateLabResult("WBC", 1.0, "K/uL");
    expect(result.warnings.some((w) => w.includes("below typical range"))).toBe(true);
  });

  it("warns on value above typical range", () => {
    const result = validateLabResult("WBC", 50.0, "K/uL");
    expect(result.warnings.some((w) => w.includes("above typical range"))).toBe(true);
  });

  it("returns valid for unknown test name (no reference data)", () => {
    const result = validateLabResult("UnknownTest", 100);
    expect(result.valid).toBe(true);
  });

  it("errors on NaN value", () => {
    const result = validateLabResult("WBC", NaN);
    expect(result.valid).toBe(false);
  });

  it("rejects glucose submitted with mmol/L (not in allowed_units)", () => {
    const result = validateLabResult("Glucose", 200, "mmol/L");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unit"))).toBe(true);
    expect(result.errors.some((e) => e.includes("mg/dL"))).toBe(true);
  });

  it("accepts glucose submitted with canonical mg/dL", () => {
    const result = validateLabResult("Glucose", 95, "mg/dL");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects glucose submitted without a unit (ambiguous)", () => {
    const result = validateLabResult("Glucose", 200);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("without a unit"))).toBe(true);
  });

  it("accepts potassium in either mEq/L or mmol/L", () => {
    expect(validateLabResult("Potassium", 4.1, "mEq/L").valid).toBe(true);
    expect(validateLabResult("Potassium", 4.1, "mmol/L").valid).toBe(true);
  });

  it("warns (not errors) on unit mismatch for a test without allowed_units", () => {
    // HbA1c uses %, no allowed_units allow-list — so a different unit is a
    // warning, not a blocking error.
    const result = validateLabResult("HbA1c", 5.5, "mmol/mol");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("does not match expected"))).toBe(true);
  });
});

// ─── isCriticalVital ────────────────────────────────────────────

describe("isCriticalVital", () => {
  it("returns true for critically low O2 sat", () => {
    expect(isCriticalVital("o2_sat", 80)).toBe(true);
  });

  it("returns true for critically high heart rate", () => {
    expect(isCriticalVital("heart_rate", 210)).toBe(true);
  });

  it("returns false for normal heart rate", () => {
    expect(isCriticalVital("heart_rate", 72)).toBe(false);
  });

  it("returns true at exact critical threshold", () => {
    const criticalLow = VITAL_DANGER_ZONES.o2_sat.criticalLow!;
    expect(isCriticalVital("o2_sat", criticalLow)).toBe(true);
  });

  it("returns false for vital type without critical thresholds", () => {
    expect(isCriticalVital("weight", 200)).toBe(false);
  });

  it("returns true for glucose 45 (severe hypoglycemia, <= criticalLow 54)", () => {
    expect(isCriticalVital("blood_glucose", 45)).toBe(true);
  });

  it("returns false for glucose 65 (above criticalLow but below warningLow)", () => {
    expect(isCriticalVital("blood_glucose", 65)).toBe(false);
  });

  it("returns false for normal glucose 120", () => {
    expect(isCriticalVital("blood_glucose", 120)).toBe(false);
  });

  it("returns true for glucose 450 (DKA territory, >= criticalHigh 350)", () => {
    expect(isCriticalVital("blood_glucose", 450)).toBe(true);
  });

  it("returns false for glucose 300 (above warningHigh but below criticalHigh)", () => {
    expect(isCriticalVital("blood_glucose", 300)).toBe(false);
  });

  it("uses adult thresholds when no age is provided", () => {
    expect(isCriticalVital("heart_rate", 150)).toBe(false);
  });

  it("flags HR 150 as critical for a toddler (age 2)", () => {
    expect(isCriticalVital("heart_rate", 150, 2)).toBe(true);
  });

  it("does not flag HR 120 as critical for a toddler (age 2)", () => {
    expect(isCriticalVital("heart_rate", 120, 2)).toBe(false);
  });

  it("flags HR 165 as critical for a neonate (age 0.01)", () => {
    expect(isCriticalVital("heart_rate", 165, 0.01)).toBe(true);
  });

  it("does not flag HR 140 as critical for a neonate (age 0.01)", () => {
    expect(isCriticalVital("heart_rate", 140, 0.01)).toBe(false);
  });

  it("flags RR 55 as critical for an infant (age 0.5)", () => {
    expect(isCriticalVital("respiratory_rate", 55, 0.5)).toBe(true);
  });

  it("flags low SBP for school-age child", () => {
    expect(isCriticalVital("blood_pressure", 80, 8)).toBe(true);
  });

  it("uses adult thresholds for age 25", () => {
    expect(isCriticalVital("heart_rate", 150, 25)).toBe(false);
  });
});

// ─── getVitalSeverity ──────────────────────────────────────────

describe("getVitalSeverity", () => {
  it("returns critical for glucose 45 (severe hypoglycemia)", () => {
    expect(getVitalSeverity("blood_glucose", 45)).toBe("critical");
  });

  it("returns warning for glucose 65 (mild hypoglycemia)", () => {
    expect(getVitalSeverity("blood_glucose", 65)).toBe("warning");
  });

  it("returns null for normal glucose 120", () => {
    expect(getVitalSeverity("blood_glucose", 120)).toBeNull();
  });

  it("returns warning for glucose 300 (hyperglycemia)", () => {
    expect(getVitalSeverity("blood_glucose", 300)).toBe("warning");
  });

  it("returns critical for glucose 450 (DKA territory)", () => {
    expect(getVitalSeverity("blood_glucose", 450)).toBe("critical");
  });

  it("returns critical for glucose at exact criticalLow boundary (54)", () => {
    expect(getVitalSeverity("blood_glucose", 54)).toBe("critical");
  });

  it("returns critical for glucose at exact criticalHigh boundary (350)", () => {
    expect(getVitalSeverity("blood_glucose", 350)).toBe("critical");
  });

  it("returns null for vital type without thresholds", () => {
    expect(getVitalSeverity("weight", 200)).toBeNull();
  });

  it("returns critical for critically low heart rate", () => {
    expect(getVitalSeverity("heart_rate", 30)).toBe("critical");
  });
});

// ─── classifyAgeGroup ──────────────────────────────────────────

describe("classifyAgeGroup", () => {
  it("classifies neonate (10 days old)", () => {
    expect(classifyAgeGroup(10 / 365.25)).toBe("neonate");
  });

  it("classifies infant (6 months old)", () => {
    expect(classifyAgeGroup(0.5)).toBe("infant");
  });

  it("classifies child (3 years old)", () => {
    expect(classifyAgeGroup(3)).toBe("child");
  });

  it("classifies school age (10 years old)", () => {
    expect(classifyAgeGroup(10)).toBe("school_age");
  });

  it("classifies adolescent (15 years old)", () => {
    expect(classifyAgeGroup(15)).toBe("adolescent");
  });

  it("classifies adult (30 years old)", () => {
    expect(classifyAgeGroup(30)).toBe("adult");
  });

  it("falls back to adult for negative age", () => {
    expect(classifyAgeGroup(-1)).toBe("adult");
  });
});

// ─── ageInYearsFromDOB ─────────────────────────────────────────

describe("ageInYearsFromDOB", () => {
  it("returns undefined for undefined DOB", () => {
    expect(ageInYearsFromDOB(undefined)).toBeUndefined();
  });

  it("returns undefined for invalid DOB string", () => {
    expect(ageInYearsFromDOB("not-a-date")).toBeUndefined();
  });

  it("computes correct age for a known reference date", () => {
    const ref = new Date("2025-01-01T00:00:00Z");
    const age = ageInYearsFromDOB("2020-01-01", ref);
    expect(age).toBeCloseTo(5, 0);
  });

  it("returns undefined for future DOB", () => {
    const ref = new Date("2025-01-01T00:00:00Z");
    expect(ageInYearsFromDOB("2026-01-01", ref)).toBeUndefined();
  });
});

// ─── getVitalRangeForAge ────────────────────────────────────────

describe("getVitalRangeForAge", () => {
  it("returns adult range when age is undefined", () => {
    const range = getVitalRangeForAge("heart_rate");
    expect(range).toEqual(VITAL_DANGER_ZONES.heart_rate);
  });

  it("returns pediatric range for child", () => {
    const range = getVitalRangeForAge("heart_rate", 3);
    expect(range).toEqual(PEDIATRIC_VITAL_RANGES.child.heart_rate);
  });

  it("falls back to adult range for vitals without pediatric data", () => {
    const range = getVitalRangeForAge("blood_glucose", 3);
    expect(range).toEqual(VITAL_DANGER_ZONES.blood_glucose);
  });

  it("returns adult range for age 20", () => {
    const range = getVitalRangeForAge("heart_rate", 20);
    expect(range).toEqual(VITAL_DANGER_ZONES.heart_rate);
  });
});

// ─── checkSystolicBP ──────────────────────────────────────────

describe("checkSystolicBP", () => {
  it("returns critical for SBP <= 55 (circulatory shock)", () => {
    expect(checkSystolicBP(50)).toBe("critical");
    expect(checkSystolicBP(55)).toBe("critical");
  });

  it("returns warning for SBP 56-89 (symptomatic hypotension)", () => {
    expect(checkSystolicBP(56)).toBe("warning");
    expect(checkSystolicBP(75)).toBe("warning");
    expect(checkSystolicBP(82)).toBe("warning");
    expect(checkSystolicBP(89)).toBe("warning");
  });

  it("returns null for SBP 90 (normal lower bound)", () => {
    expect(checkSystolicBP(90)).toBeNull();
  });

  it("returns null for SBP in normal range", () => {
    expect(checkSystolicBP(120)).toBeNull();
    expect(checkSystolicBP(140)).toBeNull();
  });

  it("returns critical for SBP >= 180 (hypertensive crisis)", () => {
    expect(checkSystolicBP(180)).toBe("critical");
    expect(checkSystolicBP(200)).toBe("critical");
  });
});
