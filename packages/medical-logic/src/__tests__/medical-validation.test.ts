import { describe, it, expect } from "vitest";
import {
  validateVital,
  validateMedicationDose,
  validateLabResult,
  isCriticalVital,
  getVitalSeverity,
  VITAL_DANGER_ZONES,
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
    const result = validateLabResult("WBC", 7.5, "10^3/uL");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on value below typical range", () => {
    const result = validateLabResult("WBC", 1.0, "10^3/uL");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("below typical range");
  });

  it("warns on value above typical range", () => {
    const result = validateLabResult("WBC", 50.0, "10^3/uL");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("above typical range");
  });

  it("returns valid for unknown test name (no reference data)", () => {
    const result = validateLabResult("UnknownTest", 100);
    expect(result.valid).toBe(true);
  });

  it("errors on NaN value", () => {
    const result = validateLabResult("WBC", NaN);
    expect(result.valid).toBe(false);
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

  it("returns true for glucose 45 (severe hypoglycemia, <= criticalLow 50)", () => {
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

  it("returns critical for glucose at exact criticalLow boundary (50)", () => {
    expect(getVitalSeverity("blood_glucose", 50)).toBe("critical");
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
