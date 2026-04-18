import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @carebridge/logger so we can assert on logger.warn() calls emitted
// by lab-units when a recorded unit is not in the accepted set.
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

import {
  findRecentLab,
  getRecentPotassium,
  getRecentSodium,
  getRecentChloride,
  getRecentEGFR,
} from "../rules/lab-units.js";
import type { PatientContext } from "../rules/cross-specialty.js";

beforeEach(() => {
  mockWarn.mockReset();
});

/**
 * Minimal PatientContext used across these tests. Only `recent_labs` is
 * exercised here — the helpers do not read any other field.
 */
const ctxWithLabs = (
  labs: Array<{ name: string; value: number; unit: string }>,
): PatientContext => ({
  active_diagnoses: [],
  active_diagnosis_codes: [],
  active_medications: [],
  new_symptoms: [],
  care_team_specialties: [],
  recent_labs: labs,
});

describe("findRecentLab (#856) — unit-aware lab lookup", () => {
  const ACCEPTED = new Set(["meq/l", "mmol/l"]);
  const NAME = /^(potassium|k\+?)$/i;

  it("returns the lab when unit is in the accepted set (canonical mEq/L)", () => {
    const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit: "mEq/L" }]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toEqual({ name: "Potassium", value: 3.2, unit: "mEq/L" });
  });

  it("returns the lab when unit is an accepted equivalent (mmol/L)", () => {
    const ctx = ctxWithLabs([{ name: "K+", value: 3.2, unit: "mmol/L" }]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toBeDefined();
    expect(lab!.value).toBe(3.2);
  });

  it("normalizes case and whitespace when checking unit", () => {
    for (const unit of ["MEQ/L", " mmol/L ", "meq/l"]) {
      const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit }]);
      const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
      expect(lab, `unit=${JSON.stringify(unit)}`).toBeDefined();
    }
  });

  it("returns undefined when the unit is NOT in the accepted set (mg/dL)", () => {
    const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit: "mg/dL" }]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toBeUndefined();
  });

  it("returns undefined when the unit is missing / empty string", () => {
    const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit: "" }]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toBeUndefined();
  });

  it("returns undefined when no lab matches the name pattern", () => {
    const ctx = ctxWithLabs([{ name: "Sodium", value: 140, unit: "mEq/L" }]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toBeUndefined();
  });

  it("returns undefined when recent_labs is undefined", () => {
    const ctx: PatientContext = {
      active_diagnoses: [],
      active_diagnosis_codes: [],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
    };
    expect(findRecentLab(ctx, NAME, ACCEPTED, "K+")).toBeUndefined();
  });

  it("skips mismatched-unit lab and returns a later matching lab (freshest wins within matches)", () => {
    // recent_labs is ordered desc by recency at the source. The helper
    // iterates in order; the first lab matching BOTH name and an
    // accepted unit wins, so a mismatched-unit row earlier in the list
    // does not block a valid later row.
    const ctx = ctxWithLabs([
      { name: "Potassium", value: 999, unit: "mg/dL" }, // wrong unit, skipped
      { name: "Potassium", value: 3.1, unit: "mEq/L" }, // accepted
    ]);
    const lab = findRecentLab(ctx, NAME, ACCEPTED, "K+");
    expect(lab).toBeDefined();
    expect(lab!.value).toBe(3.1);
  });
});

describe("getRecentPotassium (#856)", () => {
  it("matches 'Potassium', 'K', and 'K+' (case-insensitive) with mEq/L", () => {
    for (const name of ["Potassium", "potassium", "K", "k", "K+", "k+"]) {
      const ctx = ctxWithLabs([{ name, value: 3.2, unit: "mEq/L" }]);
      const lab = getRecentPotassium(ctx);
      expect(lab, `name=${name}`).toBeDefined();
      expect(lab!.value).toBe(3.2);
    }
  });

  it("accepts mmol/L as equivalent (monovalent ion, 1:1)", () => {
    const ctx = ctxWithLabs([{ name: "K+", value: 3.2, unit: "mmol/L" }]);
    expect(getRecentPotassium(ctx)).toBeDefined();
  });

  it("refuses mg/dL for K+ (nonsensical unit, fail closed)", () => {
    const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit: "mg/dL" }]);
    expect(getRecentPotassium(ctx)).toBeUndefined();
  });

  it("refuses missing / empty unit for K+ (fail closed)", () => {
    const ctx = ctxWithLabs([{ name: "Potassium", value: 3.2, unit: "" }]);
    expect(getRecentPotassium(ctx)).toBeUndefined();
  });
});

describe("getRecentSodium / getRecentChloride (#856)", () => {
  it("getRecentSodium accepts mEq/L and mmol/L", () => {
    expect(
      getRecentSodium(
        ctxWithLabs([{ name: "Sodium", value: 140, unit: "mEq/L" }]),
      ),
    ).toBeDefined();
    expect(
      getRecentSodium(ctxWithLabs([{ name: "Na", value: 140, unit: "mmol/L" }])),
    ).toBeDefined();
  });

  it("getRecentChloride accepts mEq/L and mmol/L", () => {
    expect(
      getRecentChloride(
        ctxWithLabs([{ name: "Chloride", value: 100, unit: "mEq/L" }]),
      ),
    ).toBeDefined();
    expect(
      getRecentChloride(
        ctxWithLabs([{ name: "Cl", value: 100, unit: "mmol/L" }]),
      ),
    ).toBeDefined();
  });

  it("monovalent helpers all refuse mg/dL", () => {
    expect(
      getRecentSodium(
        ctxWithLabs([{ name: "Sodium", value: 140, unit: "mg/dL" }]),
      ),
    ).toBeUndefined();
    expect(
      getRecentChloride(
        ctxWithLabs([{ name: "Chloride", value: 100, unit: "mg/dL" }]),
      ),
    ).toBeUndefined();
  });
});

describe("getRecentEGFR (#856)", () => {
  it("accepts mL/min/1.73m² and tolerant spacing/encoding variants", () => {
    for (const unit of [
      "mL/min/1.73m2",
      "mL/min/1.73m²",
      "mL/min/1.73 m2",
      "ML/MIN/1.73M²",
    ]) {
      const ctx = ctxWithLabs([{ name: "eGFR", value: 55, unit }]);
      const lab = getRecentEGFR(ctx);
      expect(lab, `unit=${JSON.stringify(unit)}`).toBeDefined();
    }
  });

  it("refuses mg/dL for eGFR (wrong unit)", () => {
    const ctx = ctxWithLabs([{ name: "eGFR", value: 1.2, unit: "mg/dL" }]);
    expect(getRecentEGFR(ctx)).toBeUndefined();
  });

  it("returns the BSA-indexed eGFR (mL/min/1.73m²) at value=25 (positive case)", () => {
    const ctx = ctxWithLabs([
      { name: "eGFR", value: 25, unit: "mL/min/1.73m²" },
    ]);
    const lab = getRecentEGFR(ctx);
    expect(lab).toBeDefined();
    expect(lab!.value).toBe(25);
    expect(lab!.unit).toBe("mL/min/1.73m²");
  });

  it("returns the BSA-indexed eGFR (ASCII variant mL/min/1.73m2) at value=25", () => {
    const ctx = ctxWithLabs([
      { name: "eGFR", value: 25, unit: "mL/min/1.73m2" },
    ]);
    const lab = getRecentEGFR(ctx);
    expect(lab).toBeDefined();
    expect(lab!.value).toBe(25);
  });

  it("REFUSES raw 'ml/min' (unindexed Cockcroft-Gault CrCl) and emits rule_lab_unit_mismatch warn (CROSS-METFORMIN-GFR-001 safety)", () => {
    // Raw mL/min is Cockcroft-Gault creatinine clearance — NOT numerically
    // equivalent to BSA-indexed mL/min/1.73m² eGFR. Can diverge 20–30% in
    // non-average-BSA patients, so the unit-check infra must fail closed.
    const ctx = ctxWithLabs([{ name: "eGFR", value: 25, unit: "ml/min" }]);
    const lab = getRecentEGFR(ctx);
    expect(lab).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      "rule_lab_unit_mismatch",
      expect.objectContaining({
        metric: "rule_lab_unit_mismatch",
        analyte: "eGFR",
        lab_unit: "ml/min",
      }),
    );
  });

  it("REFUSES raw 'mL/min' (mixed-case, unindexed) — normalization must not smuggle it back in", () => {
    const ctx = ctxWithLabs([{ name: "eGFR", value: 25, unit: "mL/min" }]);
    expect(getRecentEGFR(ctx)).toBeUndefined();
  });
});
