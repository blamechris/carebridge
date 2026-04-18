import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @carebridge/logger so we can assert on logger.warn() calls when an
// unrecognized lab flag is encountered (issue #834).
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

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

// ─── Lab-provided flag precedence (issue #244) ───────────────────
describe("checkCriticalValues — lab-provided flag precedence", () => {
  it("flags unknown lab as critical when the lab reports flag='critical' and no reference range is supplied", () => {
    // Regression: previously this silently slipped through because the lab
    // was not in COMMON_LAB_TESTS and had no reference range. An analyzing
    // laboratory explicitly flagging the value as critical is authoritative.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 999,
          unit: "U/L",
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-OBSCURE_MARKER_X");
  });

  it("emits warning flag when lab reports flag='H' without a reference range", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Novel Biomarker",
          value: 42,
          unit: "pg/mL",
          flag: "H",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("High");
  });

  it("emits warning flag when lab reports flag='L' without a reference range", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Novel Biomarker",
          value: 0.1,
          unit: "pg/mL",
          flag: "L",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("Low");
  });

  it("honors lab flag even when value is within COMMON_LAB_TESTS typical range", () => {
    // A lab flagging a result as critical overrides typical-range fallback
    // even when the value itself would otherwise look benign. The laboratory
    // has more context (patient baseline, critical-value policy) than we do.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Hemoglobin",
          value: 13.5, // within typical 12.0–17.5
          unit: "g/dL",
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
  });

  it("prefers per-result reference_low/reference_high over COMMON_LAB_TESTS", () => {
    // Scenario: lab reports Potassium with a patient-specific reference range
    // (e.g. 3.0–5.5 for a CKD patient on K-binders). A value of 5.4 would be
    // "high" by COMMON_LAB_TESTS (typical_high=5.0) but within the per-result
    // range. The per-result range must win; this result should NOT be flagged
    // by the heuristic fallback (POTASSIUM explicit threshold is separate).
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Nonstandard Metabolite",
          value: 10,
          unit: "mg/dL",
          reference_low: 5,
          reference_high: 15,
        },
      ]),
    );
    // 10 is mid-range, no flag expected.
    expect(flags).toHaveLength(0);
  });

  it("uses per-result reference range to detect far-outside when COMMON_LAB_TESTS disagrees", () => {
    // Per-result reference range: 3.5–5.0 (range=1.5). Value 8.5 is far above
    // (> 5.0 + 1.5 = 6.5) so should flag critical regardless of COMMON_LAB_TESTS.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Rare Analyte Y",
          value: 8.5,
          unit: "mmol/L",
          reference_low: 3.5,
          reference_high: 5.0,
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rationale).toContain("3.5");
    expect(flags[0]!.rationale).toContain("5");
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

// ─── Rule ID / severity prefix harmonization (issue #836) ───────
// Prior to this harmonization, the explicit-threshold path hard-coded a
// `CRITICAL-LAB-*` prefix regardless of the threshold's actual severity
// (e.g. Troponin I 0.04–0.4 ng/mL was a "warning" severity but emitted
// `CRITICAL-LAB-TROPONIN_I`). The heuristic fallback path already varied
// the prefix by severity. Downstream consumers that filter on rule_id
// prefix saw inconsistent semantics. These tests lock in the harmonized
// mapping: severity="critical" → CRITICAL-LAB-*, "warning" → WARNING-LAB-*.
describe("checkCriticalValues — severity-matched rule_id prefix (issue #836)", () => {
  it("uses CRITICAL-LAB-* prefix when explicit threshold resolves to critical", () => {
    // Troponin I > 0.4 ng/mL → severity="critical".
    const flags = checkCriticalValues(
      makeLabEvent([{ test_name: "Troponin I", value: 1.2, unit: "ng/mL" }]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-TROPONIN_I");
  });

  it("uses WARNING-LAB-* prefix when explicit threshold resolves to warning", () => {
    // Troponin I in (0.04, 0.4] ng/mL → severity="warning". Before #836 this
    // path emitted `CRITICAL-LAB-TROPONIN_I` despite warning severity.
    const flags = checkCriticalValues(
      makeLabEvent([{ test_name: "Troponin I", value: 0.1, unit: "ng/mL" }]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("WARNING-LAB-TROPONIN_I");
  });

  it("uses WARNING-LAB-* prefix for heuristic-fallback warnings (H/L flags)", () => {
    // Heuristic fallback path for an unknown analyte with `flag: "H"` →
    // severity="warning". Rule-id prefix must match.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Novel Biomarker",
          value: 42,
          unit: "pg/mL",
          flag: "H",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.rule_id).toBe("WARNING-LAB-NOVEL_BIOMARKER");
  });

  it("uses CRITICAL-LAB-* prefix for heuristic-fallback critical flags", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 999,
          unit: "U/L",
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-OBSCURE_MARKER_X");
  });
});

// ─── Direction inference for critical flag (issue #833) ──────────
// Regression guard for the half-bounded reference-range case. Prior to the
// fix, `direction` defaulted to "high" whenever `reference_low` was missing,
// even when the value was clearly below `reference_high`. A critical-low
// result mis-tagged as "high" erodes clinician trust and can delay treatment
// (e.g., a panic-low magnesium reported as "high").
describe("checkCriticalValues — direction inference (issue #833)", () => {
  it("infers direction='low' when reference_high is provided, reference_low is absent, and value is below reference_high", () => {
    // Half-bounded reference range (reference_low missing). Value 0.4 is
    // clearly below reference_high 1.5, so direction MUST be 'low'.
    // The fix surfaces direction in the summary: "Critical low lab result"
    // instead of the previous mis-directed "Critical high lab result".
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker Y",
          value: 0.4,
          unit: "mg/dL",
          reference_high: 1.5,
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    // Regression assertion — the summary must describe direction truthfully.
    expect(flags[0]!.summary.toLowerCase()).toContain("low");
    expect(flags[0]!.summary.toLowerCase()).not.toContain("high");
  });

  it("infers direction='high' when reference_low is provided, reference_high is absent, and value is above reference_low", () => {
    // Half-bounded the other way — only reference_low present. Value 999 is
    // clearly above reference_low 10, so direction MUST be 'high'.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker Z",
          value: 999,
          unit: "U/L",
          reference_low: 10,
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary.toLowerCase()).toContain("high");
    // The summary should not claim "low" when the value is above the only
    // reference bound we have.
    expect(flags[0]!.summary.toLowerCase()).not.toContain("low");
  });

  it("defaults direction='high' when no reference bounds are provided (unchanged behavior)", () => {
    // With neither reference_low nor reference_high, we cannot infer
    // direction from the reference range. The historical default is 'high'.
    // Most laboratory "critical" flags are elevations in practice, so this
    // is a reasonable fallback. Pin the behavior so changes are intentional.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker W",
          value: 42,
          unit: "U/L",
          flag: "critical",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary.toLowerCase()).toContain("high");
  });
});

// ─── Unrecognized flag handling (issues #834 and #837) ───────────
// When a lab result carries a non-null `flag` string that is not in the
// validator enum ('H' | 'L' | 'critical'), we must:
//   1. Still fall through to the range checks (no behavior change).
//   2. Emit logger.warn so silent drops of an explicit lab abnormality
//      signal become observable. Silent drops of explicit lab-marked
//      abnormalities are exactly the class of bug #244 was filed to fix.
// We additionally map common HL7v2 abnormal-flag values:
//   - "HH" (panic high) → warning, direction="high"
//   - "LL" (panic low)  → warning, direction="low"
// Other non-enum values (e.g. "abnormal", "A", "") still fall through
// but the warn fires. See issues #833 and #834 for rationale.
describe("checkCriticalValues — unrecognized flag handling (issues #834, #837)", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it("falls through to range checks when flag is an unrecognized value", () => {
    // Issue #837: pin current fall-through behavior so future regressions are
    // intentional. Lab with an unrecognized "abnormal" flag, no reference
    // range, not in COMMON_LAB_TESTS → no flag emitted from the flag branch.
    // (With HH/LL mapping, the test uses a value that is not HH/LL.)
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 999,
          unit: "U/L",
          flag: "abnormal",
        },
      ]),
    );
    expect(flags).toHaveLength(0);
  });

  it("logs a warning when a non-null flag is not in the recognized enum (empty string)", () => {
    checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 5,
          unit: "U/L",
          flag: "",
        },
      ]),
    );
    expect(mockWarn).toHaveBeenCalled();
    const call = mockWarn.mock.calls.find(
      // Issue #851: event name must match the metric field (`_total` suffix).
      ([msg]) => msg === "unrecognized_lab_flag_total",
    );
    expect(call).toBeDefined();
  });

  it("logs a warning for an unrecognized flag value 'abnormal'", () => {
    checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 5,
          unit: "U/L",
          flag: "abnormal",
        },
      ]),
    );
    expect(mockWarn).toHaveBeenCalled();
    const call = mockWarn.mock.calls.find(
      // Issue #851: event name must match the metric field (`_total` suffix).
      ([msg]) => msg === "unrecognized_lab_flag_total",
    );
    expect(call).toBeDefined();
    // Meta payload should capture the offending flag value (no PHI).
    const meta = call![1] as Record<string, unknown>;
    expect(meta.flag).toBe("abnormal");
    expect(meta.test_name).toBe("Obscure Marker X");
  });

  it("does not warn when flag is in the recognized enum ('H', 'L', 'critical') or absent", () => {
    checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Hemoglobin",
          value: 13.5,
          unit: "g/dL",
          flag: "H",
        },
        {
          test_name: "Hemoglobin",
          value: 11.5,
          unit: "g/dL",
          flag: "L",
        },
        {
          test_name: "Hemoglobin",
          value: 14,
          unit: "g/dL",
          flag: "critical",
        },
        {
          test_name: "Hemoglobin",
          value: 14,
          unit: "g/dL",
        },
      ]),
    );
    // None of these should trigger unrecognized_lab_flag_total warnings.
    const unrecognizedCalls = mockWarn.mock.calls.filter(
      // Issue #851: event name must match the metric field (`_total` suffix).
      ([msg]) => msg === "unrecognized_lab_flag_total",
    );
    expect(unrecognizedCalls).toHaveLength(0);
  });

  it("uses event name matching the metric field with _total suffix (issue #851)", () => {
    // Pin the harmonized convention: logger.warn's event name string must
    // equal the `metric` field. Before #851 the event name was
    // "unrecognized_lab_flag" (no `_total`), producing log-vs-metric
    // aggregation drift against the convention in
    // `utils/validate-event-timestamp.ts`.
    checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 5,
          unit: "U/L",
          flag: "abnormal",
        },
      ]),
    );
    const call = mockWarn.mock.calls.find(
      ([msg]) => msg === "unrecognized_lab_flag_total",
    );
    expect(call).toBeDefined();
    const meta = call![1] as Record<string, unknown>;
    expect(meta.metric).toBe("unrecognized_lab_flag_total");
  });

  it("maps HL7v2 'HH' (panic high) to a warning flag with direction='high'", () => {
    // HL7v2 abnormal-flags: "HH" means panic/critical-high. Treat as warning
    // (not critical) to avoid over-alerting pending principled mapping —
    // see issue #834 discussion. Warning is the floor, not the ceiling.
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 999,
          unit: "U/L",
          flag: "HH",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("High");
    // This mapping should still emit the warn log so operators notice
    // non-enum flags arriving through FHIR/HL7 ingress paths.
    expect(mockWarn).toHaveBeenCalled();
  });

  it("maps HL7v2 'LL' (panic low) to a warning flag with direction='low'", () => {
    const flags = checkCriticalValues(
      makeLabEvent([
        {
          test_name: "Obscure Marker X",
          value: 0.01,
          unit: "U/L",
          flag: "LL",
        },
      ]),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.summary).toContain("Low");
    expect(mockWarn).toHaveBeenCalled();
  });
});
