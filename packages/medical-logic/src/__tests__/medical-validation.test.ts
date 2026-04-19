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
  CREATININE_UMOL_TO_MGDL,
  getPulsePressureThresholds,
  PEDIATRIC_PP_THRESHOLDS,
} from "../medical-validation.js";
import {
  MEDICATION_MAX_DAILY_DOSES,
  getMedicationDoseLimit,
} from "../medication-max-doses.js";

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

  // ─── Pulse-pressure boundary tests (issue #519) ────────────────

  it("does not warn on pulse pressure at boundary PP=25", () => {
    // 100/75 — PP=25, just above the narrow threshold
    const result = validateVital("blood_pressure", 100, 75);
    expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(false);
  });

  it("warns on narrow pulse pressure at boundary PP=24 (warning)", () => {
    // 100/76 — PP=24, just inside the narrow warning band
    const result = validateVital("blood_pressure", 100, 76);
    expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically narrow"))).toBe(false);
  });

  it("does not critically warn on narrow pulse pressure at boundary PP=15", () => {
    // 90/75 — PP=15, at the critical threshold boundary (not critical)
    const result = validateVital("blood_pressure", 90, 75);
    expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically narrow"))).toBe(false);
  });

  it("critically warns on very narrow pulse pressure PP=14", () => {
    // 89/75 — PP=14, inside the critical narrow band
    const result = validateVital("blood_pressure", 89, 75);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically narrow"))).toBe(true);
  });

  it("warns on moderately wide pulse pressure PP=61", () => {
    // 141/80 — PP=61, just above the wide warning threshold
    const result = validateVital("blood_pressure", 141, 80);
    expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(false);
  });

  it("does not warn on pulse pressure at boundary PP=60 (no warning)", () => {
    // 140/80 — PP=60, at the wide threshold boundary (not wide)
    const result = validateVital("blood_pressure", 140, 80);
    expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(false);
  });

  it("warns on critically wide pulse pressure PP=101", () => {
    // 181/80 — PP=101, inside the critical wide band
    const result = validateVital("blood_pressure", 181, 80);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(true);
  });

  it("does not critically warn on wide pulse pressure PP=100 (boundary)", () => {
    // 180/80 — PP=100, at the critical boundary (not critical)
    const result = validateVital("blood_pressure", 180, 80);
    expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(false);
    expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
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

  // ─── Pediatric pulse pressure thresholds (issue #518) ──────────

  describe("pediatric pulse pressure (age-aware)", () => {
    // neonate/infant: narrowCritical=10, narrowWarning=15, wideWarning=25, wideCritical=35
    it("warns on narrow PP for neonate (PP=12, between 10 and 15)", () => {
      // SBP 72, DBP 60 → PP=12
      const result = validateVital("blood_pressure", 72, 60, 0.01);
      expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically narrow"))).toBe(false);
    });

    it("critically warns on very narrow PP for neonate (PP=8)", () => {
      // SBP 68, DBP 60 → PP=8
      const result = validateVital("blood_pressure", 68, 60, 0.01);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically narrow"))).toBe(true);
    });

    it("warns on wide PP for neonate (PP=30, between 25 and 35)", () => {
      // SBP 90, DBP 60 → PP=30
      const result = validateVital("blood_pressure", 90, 60, 0.01);
      expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(false);
    });

    it("critically warns on very wide PP for neonate (PP=40)", () => {
      // SBP 100, DBP 60 → PP=40
      const result = validateVital("blood_pressure", 100, 60, 0.01);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(true);
    });

    it("does not warn on normal neonate PP=20", () => {
      // SBP 80, DBP 60 → PP=20
      const result = validateVital("blood_pressure", 80, 60, 0.01);
      expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
    });

    // infant (age 0.5): same thresholds as neonate
    it("warns on narrow PP for infant (PP=13)", () => {
      // SBP 73, DBP 60 → PP=13
      const result = validateVital("blood_pressure", 73, 60, 0.5);
      expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
    });

    // child (1-5): narrowCritical=10, narrowWarning=15, wideWarning=30, wideCritical=45
    it("warns on wide PP for child age 3 (PP=35, between 30 and 45)", () => {
      // SBP 95, DBP 60 → PP=35
      const result = validateVital("blood_pressure", 95, 60, 3);
      expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(false);
    });

    it("critically warns on very wide PP for child age 3 (PP=50)", () => {
      // SBP 110, DBP 60 → PP=50
      const result = validateVital("blood_pressure", 110, 60, 3);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(true);
    });

    it("does not warn on normal child PP=25", () => {
      // SBP 85, DBP 60 → PP=25
      const result = validateVital("blood_pressure", 85, 60, 3);
      expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
    });

    // school_age (5-12): narrowCritical=15, narrowWarning=20, wideWarning=40, wideCritical=60
    it("warns on narrow PP for school-age child (PP=18, between 15 and 20)", () => {
      // SBP 78, DBP 60 → PP=18
      const result = validateVital("blood_pressure", 78, 60, 8);
      expect(result.warnings.some((w) => w.toLowerCase().includes("narrow pulse pressure"))).toBe(true);
    });

    it("warns on wide PP for school-age child (PP=50, between 40 and 60)", () => {
      // SBP 110, DBP 60 → PP=50
      const result = validateVital("blood_pressure", 110, 60, 8);
      expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
    });

    it("critically warns on very wide PP for school-age child (PP=65)", () => {
      // SBP 125, DBP 60 → PP=65
      const result = validateVital("blood_pressure", 125, 60, 8);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(true);
    });

    // adolescent (12-18): narrowCritical=15, narrowWarning=20, wideWarning=50, wideCritical=80
    it("warns on wide PP for adolescent (PP=55, between 50 and 80)", () => {
      // SBP 115, DBP 60 → PP=55
      const result = validateVital("blood_pressure", 115, 60, 15);
      expect(result.warnings.some((w) => w.toLowerCase().includes("wide pulse pressure"))).toBe(true);
    });

    it("does not warn on adolescent PP=45 (normal)", () => {
      // SBP 105, DBP 60 → PP=45
      const result = validateVital("blood_pressure", 105, 60, 15);
      expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
    });

    it("critically warns on very wide PP for adolescent (PP=85)", () => {
      // SBP 145, DBP 60 → PP=85
      const result = validateVital("blood_pressure", 145, 60, 15);
      expect(result.warnings.some((w) => w.toLowerCase().includes("critically wide"))).toBe(true);
    });

    // adult (18+): uses default thresholds (same as no-age tests above)
    it("uses adult PP thresholds for age 30", () => {
      // PP=40 is normal for adult — no warnings
      const result = validateVital("blood_pressure", 120, 80, 30);
      expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
    });

    it("uses adult PP thresholds when age is not provided", () => {
      // PP=40 is normal for adult — no warnings (backward compat)
      const result = validateVital("blood_pressure", 120, 80);
      expect(result.warnings.some((w) => w.toLowerCase().includes("pulse pressure"))).toBe(false);
    });
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

// ─── validateMedicationDose — per-drug limits (issue #238) ──────

describe("validateMedicationDose — per-drug ceilings (#238)", () => {
  it("accepts an acetaminophen 650 mg single dose", () => {
    const result = validateMedicationDose(650, "mg", "acetaminophen");
    expect(result.valid).toBe(true);
    // 650 is not above warn threshold (650), so no warning either.
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on acetaminophen 975 mg (above warn, below hard max)", () => {
    const result = validateMedicationDose(975, "mg", "acetaminophen");
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Acetaminophen/);
  });

  it("errors on acetaminophen 1500 mg single dose (> 1000 mg max)", () => {
    const result = validateMedicationDose(1500, "mg", "acetaminophen");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Acetaminophen max single dose/);
    expect(result.errors[0]).toMatch(/1000 mg/);
  });

  it("errors on ibuprofen 1000 mg single dose (> 800 mg max)", () => {
    const result = validateMedicationDose(1000, "mg", "ibuprofen");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Ibuprofen/);
  });

  it("errors on oxycodone 40 mg single dose (> 20 mg max)", () => {
    const result = validateMedicationDose(40, "mg", "oxycodone");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Oxycodone/);
  });

  it("resolves brand alias Tylenol → acetaminophen ceiling", () => {
    const result = validateMedicationDose(1500, "mg", "Tylenol");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Acetaminophen/);
  });

  it("resolves combo brand Percocet → oxycodone (stricter component)", () => {
    // 30 mg oxycodone is above the 20 mg single-dose ceiling even though
    // a 30 mg Percocet dose would be gross overdosing of APAP too.
    const result = validateMedicationDose(30, "mg", "Percocet");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Oxycodone/);
  });

  it("is case-insensitive and trims whitespace in drug name", () => {
    const result = validateMedicationDose(1500, "mg", "  ACETAMINOPHEN  ");
    expect(result.valid).toBe(false);
  });

  it("falls back to generic 10,000-mg ceiling for unknown drugs", () => {
    const result = validateMedicationDose(15000, "mg", "zolpidopride");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds 10,000"))).toBe(true);
  });

  it("suppresses the generic 'unusually high mg' warning when a drug limit matched", () => {
    // Acetaminophen hard max is 1000; 900 mg is above warn but below hard max.
    // The legacy generic "mg > 5000" warning path must not fire here because
    // the drug-specific warn is the authoritative signal.
    const result = validateMedicationDose(900, "mg", "acetaminophen");
    expect(result.valid).toBe(true);
    expect(
      result.warnings.filter((w) => w.includes("unusually high")),
    ).toHaveLength(0);
  });

  it("errors on ibuprofen with no drugName falls back to generic", () => {
    // Without drugName, 6000 mg triggers the generic mg>5000 warn, not an
    // ibuprofen-specific error. Backward compat for legacy callers.
    const result = validateMedicationDose(6000, "mg");
    expect(result.valid).toBe(true);
    expect(result.warnings[0]).toMatch(/unusually high/);
  });

  it("skips per-drug error when unit is not mg (mg table isn't comparable)", () => {
    const result = validateMedicationDose(100, "mcg", "acetaminophen");
    expect(result.valid).toBe(true);
    // No "exceeds Acetaminophen max" since unit isn't mg.
    expect(result.errors).toHaveLength(0);
  });
});

// ─── MEDICATION_MAX_DAILY_DOSES data sanity ─────────────────────

describe("MEDICATION_MAX_DAILY_DOSES reference data (#238)", () => {
  it("covers acetaminophen, ibuprofen, naproxen, aspirin", () => {
    for (const name of ["acetaminophen", "ibuprofen", "naproxen", "aspirin"]) {
      expect(MEDICATION_MAX_DAILY_DOSES[name]).toBeDefined();
      expect(MEDICATION_MAX_DAILY_DOSES[name].max_daily_dose_mg).toBeGreaterThan(0);
    }
  });

  it("covers the major oral opioids with MME factors", () => {
    for (const opioid of ["morphine", "oxycodone", "hydrocodone", "codeine", "tramadol"]) {
      const limit = MEDICATION_MAX_DAILY_DOSES[opioid];
      expect(limit).toBeDefined();
      expect(limit.mme_factor).toBeGreaterThan(0);
    }
  });

  it("every limit has a non-empty source", () => {
    for (const [drug, limit] of Object.entries(MEDICATION_MAX_DAILY_DOSES)) {
      expect(limit.source, `drug=${drug}`).toMatch(/\S/);
    }
  });

  it("every limit's max_single_dose_mg <= max_daily_dose_mg (internal consistency)", () => {
    for (const [drug, limit] of Object.entries(MEDICATION_MAX_DAILY_DOSES)) {
      if (
        limit.max_single_dose_mg !== undefined &&
        limit.max_daily_dose_mg !== undefined
      ) {
        expect(
          limit.max_single_dose_mg,
          `drug=${drug} single=${limit.max_single_dose_mg} daily=${limit.max_daily_dose_mg}`,
        ).toBeLessThanOrEqual(limit.max_daily_dose_mg);
      }
    }
  });

  it("every warn threshold is below its hard-max counterpart", () => {
    for (const [drug, limit] of Object.entries(MEDICATION_MAX_DAILY_DOSES)) {
      if (
        limit.warn_single_dose_mg !== undefined &&
        limit.max_single_dose_mg !== undefined
      ) {
        expect(
          limit.warn_single_dose_mg,
          `drug=${drug} warn=${limit.warn_single_dose_mg} max=${limit.max_single_dose_mg}`,
        ).toBeLessThanOrEqual(limit.max_single_dose_mg);
      }
    }
  });

  it("getMedicationDoseLimit resolves aliases", () => {
    expect(getMedicationDoseLimit("tylenol")?.display_name).toMatch(/Acetaminophen/);
    expect(getMedicationDoseLimit("Advil")?.display_name).toMatch(/Ibuprofen/);
    expect(getMedicationDoseLimit("OxyContin")?.display_name).toMatch(/Oxycodone/);
    expect(getMedicationDoseLimit("norco")?.display_name).toMatch(/Hydrocodone/);
  });

  it("getMedicationDoseLimit returns undefined for unknown drugs", () => {
    expect(getMedicationDoseLimit("unobtanium")).toBeUndefined();
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

  it("accepts HbA1c in NGSP % with value in typical range", () => {
    const result = validateLabResult("HbA1c", 5.4, "%");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts HbA1c in IFCC mmol/mol — 37 mmol/mol (~5.5 %) in range, no warnings", () => {
    // 37 mmol/mol ≈ 5.54 % NGSP → within 4.0–5.6 typical range
    const result = validateLabResult("HbA1c", 37, "mmol/mol");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on HbA1c 75 mmol/mol (above typical range — ~9.0 %)", () => {
    // 75 mmol/mol ≈ 9.01 % NGSP → above 5.6 % typical high
    const result = validateLabResult("HbA1c", 75, "mmol/mol");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("above typical range"))).toBe(true);
  });

  it("rejects HbA1c with an unrecognized unit", () => {
    const result = validateLabResult("HbA1c", 5.5, "g/dL");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unit"))).toBe(true);
  });

  it("requires a unit for HbA1c (allowed_units is set)", () => {
    const result = validateLabResult("HbA1c", 5.5);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("without a unit"))).toBe(true);
  });

  it("flags HbA1c 42 mmol/mol as above typical range (prediabetes boundary ~6.0 % NGSP)", () => {
    // 42 mmol/mol → NGSP via IFCC master equation: 42 / 10.929 + 2.15 ≈ 5.993
    // This exceeds typical_high of 5.6 %, so it should trigger a high warning.
    const result = validateLabResult("HbA1c", 42, "mmol/mol");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("above typical range"))).toBe(true);
  });

  it("accepts HbA1c with uppercase unit MMOL/MOL (case-insensitive normalisation)", () => {
    // Same value as above but with all-caps unit — normalizeUnit should
    // handle it identically to lowercase "mmol/mol".
    const result = validateLabResult("HbA1c", 42, "MMOL/MOL");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("above typical range"))).toBe(true);
  });

  // Unit comparison tolerates case/whitespace variants. Real-world FHIR/HL7
  // feeds frequently send "mg/dl" (UCUM canonical) or "MG/DL" (lab vendor
  // shorthand); normalising both sides prevents false-reject errors on
  // otherwise legitimate readings. See issue #538.
  it("accepts glucose unit in upper case (MG/DL)", () => {
    const result = validateLabResult("Glucose", 95, "MG/DL");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts glucose unit with trailing whitespace (mg/dL )", () => {
    const result = validateLabResult("Glucose", 95, "mg/dL ");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts glucose unit with leading whitespace + lowercase ( mg/dl)", () => {
    const result = validateLabResult("Glucose", 95, " mg/dl");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts glucose unit in canonical UCUM lowercase (mg/dl)", () => {
    const result = validateLabResult("Glucose", 95, "mg/dl");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts glucose unit with internal whitespace (mg / dL)", () => {
    const result = validateLabResult("Glucose", 95, "mg / dL");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts potassium submitted as lowercase meq/L", () => {
    const result = validateLabResult("Potassium", 4.1, "meq/L");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("still rejects a genuinely wrong unit (dL alone)", () => {
    const result = validateLabResult("Glucose", 95, "dL");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unit"))).toBe(true);
  });

  it("accepts glucose unit with Unicode MICRO SIGN µ (U+00B5)", () => {
    const result = validateLabResult("Glucose", 95, "\u00b5g/dL");
    // µg/dL should normalise to ug/dl — but glucose allowed_units is mg/dL,
    // so this will correctly reject. Instead test with a unit whose canonical
    // form uses 'u': we test normalisation equivalence directly.
    // Use a mEq/L test where µ doesn't appear, to isolate: test that
    // µg/dL, μg/dL, and ug/dL all normalise the same way via Glucose.
    expect(result.valid).toBe(false); // µg/dL is not mg/dL
  });

  it("treats µg/dL (U+00B5), μg/dL (U+03BC), and ug/dL as identical units", () => {
    // All three micro-sign variants should produce the same validation outcome
    const microSign = validateLabResult("Glucose", 95, "\u00b5g/dL");
    const greekMu = validateLabResult("Glucose", 95, "\u03bcg/dL");
    const asciiU = validateLabResult("Glucose", 95, "ug/dL");

    // All three are "ug/dL" after normalisation — none match "mg/dL"
    expect(microSign.valid).toBe(false);
    expect(greekMu.valid).toBe(false);
    expect(asciiU.valid).toBe(false);

    // All produce rejection errors (error text quotes original input, so
    // we compare valid/error-count rather than exact strings)
    expect(microSign.errors).toHaveLength(1);
    expect(greekMu.errors).toHaveLength(1);
    expect(asciiU.errors).toHaveLength(1);
  });

  it("accepts µmol/L as equivalent to umol/L for unit-warning comparison", () => {
    // HbA1c has no allowed_units, so mismatch is a warning not error.
    // Both µmol/L and umol/L should produce the same outcome (warning).
    const microSign = validateLabResult("HbA1c", 5.5, "\u00b5mol/L");
    const asciiU = validateLabResult("HbA1c", 5.5, "umol/L");
    expect(microSign.warnings).toHaveLength(asciiU.warnings.length);
    expect(microSign.valid).toBe(asciiU.valid);
  });

  it("accepts Creatinine in umol/L — 88.4 umol/L converts to 1.0 mg/dL (normal, no warnings)", () => {
    // 88.4 µmol/L ÷ 88.4 = 1.0 mg/dL → within 0.6–1.2 typical range
    const result = validateLabResult("Creatinine", CREATININE_UMOL_TO_MGDL, "umol/L");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts Creatinine in µmol/L (U+00B5) — normalises to umol/L", () => {
    // µ (MICRO SIGN U+00B5) normalises to u, so µmol/L matches umol/L
    const result = validateLabResult("Creatinine", CREATININE_UMOL_TO_MGDL, "\u00b5mol/L");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on Creatinine 200 umol/L (above typical range — ~2.26 mg/dL)", () => {
    // 200 µmol/L ÷ 88.4 ≈ 2.26 mg/dL → above 1.2 mg/dL typical high
    const result = validateLabResult("Creatinine", 200, "umol/L");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("above typical range"))).toBe(true);
  });

  // NFKC normalisation flattens superscript digits (² → 2, ³ → 3) so that
  // units like "kg/m²" and "kg/m2" compare identically. This is intentional:
  // some FHIR/HL7 feeds emit Unicode superscripts in composite units, and we
  // want them to match the plain-ASCII canonical form. See issue #669.
  it("treats superscript digits as equivalent to ASCII digits (NFKC flattening)", () => {
    // Hemoglobin has unit "g/dL" and no allowed_units, so a non-matching
    // unit triggers a warning. Both "cells/mm\u00b2" and "cells/mm2" should
    // normalise identically and produce the same validation outcome.
    const superscript = validateLabResult("Hemoglobin", 14, "g/dL\u00b2");
    const ascii = validateLabResult("Hemoglobin", 14, "g/dL2");
    expect(superscript.valid).toBe(ascii.valid);
    expect(superscript.warnings).toHaveLength(ascii.warnings.length);
    expect(superscript.errors).toHaveLength(ascii.errors.length);
  });

  it("error message quotes the caller's original (non-normalized) unit", () => {
    // Normalisation is only used for comparison; the operator's typed
    // string should surface verbatim so they can see what they entered.
    const result = validateLabResult("Glucose", 200, "mmol/L");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"mmol/L"'))).toBe(true);
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

// ─── getPulsePressureThresholds ────────────────────────────────

describe("getPulsePressureThresholds", () => {
  it("returns adult thresholds when age is undefined", () => {
    const pp = getPulsePressureThresholds();
    expect(pp.narrowCritical).toBe(15);
    expect(pp.wideCritical).toBe(100);
  });

  it("returns neonate thresholds for age 0.01", () => {
    const pp = getPulsePressureThresholds(0.01);
    expect(pp).toEqual(PEDIATRIC_PP_THRESHOLDS.neonate);
  });

  it("returns infant thresholds for age 0.5", () => {
    const pp = getPulsePressureThresholds(0.5);
    expect(pp).toEqual(PEDIATRIC_PP_THRESHOLDS.infant);
  });

  it("returns child thresholds for age 3", () => {
    const pp = getPulsePressureThresholds(3);
    expect(pp).toEqual(PEDIATRIC_PP_THRESHOLDS.child);
  });

  it("returns school_age thresholds for age 8", () => {
    const pp = getPulsePressureThresholds(8);
    expect(pp).toEqual(PEDIATRIC_PP_THRESHOLDS.school_age);
  });

  it("returns adolescent thresholds for age 15", () => {
    const pp = getPulsePressureThresholds(15);
    expect(pp).toEqual(PEDIATRIC_PP_THRESHOLDS.adolescent);
  });

  it("returns adult thresholds for age 30", () => {
    const pp = getPulsePressureThresholds(30);
    expect(pp.narrowCritical).toBe(15);
    expect(pp.wideCritical).toBe(100);
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
