/**
 * Tests for flag consolidation — specifically the narrow case where
 * CRITICAL-LAB-POTASSIUM co-fires with a cross-specialty hypokalemia rule
 * (CROSS-QT-HYPOK-001, #854; CROSS-THIAZIDE-HYPOK-001, #878) for the same
 * underlying severe-hypokalemia signal.
 *
 * Policy: when the critical-value flag co-fires with either cross-specialty
 * hypoK rule in the same review pass, suppress the CRITICAL-LAB-POTASSIUM
 * flag. The cross-specialty flag is strictly more actionable because it
 * names the offending medication class, and the flags point clinicians at
 * the same physiologic concern (hypokalemia → arrhythmia / electrolyte
 * risk).
 *
 * Safety floor (non-goals, enforced by these tests):
 *   - Do not suppress CRITICAL-LAB-POTASSIUM when firing alone.
 *   - Do not suppress any other CRITICAL-LAB-* analyte.
 *   - Do not suppress hyperkalemia critical flags (they share the
 *     CRITICAL-LAB-POTASSIUM rule_id but describe a different mechanism;
 *     the hypoK cross-specialty rules cannot co-fire with a hyperkalemia
 *     flag, so we rely on the rule source: only drop when a cross-specialty
 *     hypoK rule is present).
 */

import { describe, it, expect } from "vitest";
import type { RuleFlag } from "@carebridge/shared-types";
import { consolidateRuleFlags } from "../services/review-service.js";

function ruleFlag(overrides: Partial<RuleFlag> = {}): RuleFlag {
  return {
    rule_id: "TEST-RULE-001",
    severity: "warning",
    category: "cross-specialty",
    summary: "test flag",
    rationale: "",
    suggested_action: "",
    notify_specialties: [],
    ...overrides,
  };
}

function criticalPotassium(severity: RuleFlag["severity"] = "critical"): RuleFlag {
  return ruleFlag({
    rule_id: "CRITICAL-LAB-POTASSIUM",
    severity,
    category: "critical-value",
    summary: "Critical hypokalemia: Potassium 2.8 mEq/L (<3.0 — cardiac arrest risk)",
    notify_specialties: ["nephrology", "cardiology"],
  });
}

function qtHypoK(severity: RuleFlag["severity"] = "critical"): RuleFlag {
  return ruleFlag({
    rule_id: "CROSS-QT-HYPOK-001",
    severity,
    category: "cross-specialty",
    summary:
      "Patient on QT-prolonging medication with hypokalemia (K+ < 3.5) — elevated risk of torsades de pointes",
    notify_specialties: ["cardiology"],
  });
}

function thiazideHypoK(severity: RuleFlag["severity"] = "critical"): RuleFlag {
  return ruleFlag({
    rule_id: "CROSS-THIAZIDE-HYPOK-001",
    severity,
    category: "cross-specialty",
    summary:
      "Patient on thiazide diuretic with hypokalemia (K+ < 3.5) — elevated arrhythmia risk",
    notify_specialties: ["nephrology", "cardiology"],
  });
}

describe("consolidateRuleFlags — CRITICAL-LAB-POTASSIUM / CROSS-QT-HYPOK-001 dedup (#854)", () => {
  it("suppresses CRITICAL-LAB-POTASSIUM when CROSS-QT-HYPOK-001 also fires", () => {
    // Patient with K+ 2.8 on ondansetron: both rules fire. Emit only the
    // cross-specialty flag — it's more actionable (names the QT drug).
    const flags = [criticalPotassium("critical"), qtHypoK("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-QT-HYPOK-001");
  });

  it("preserves CROSS-QT-HYPOK-001 ordering-independent: suppression works regardless of input order", () => {
    const flags = [qtHypoK("critical"), criticalPotassium("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-QT-HYPOK-001");
  });

  it("preserves critical severity on the surviving CROSS-QT-HYPOK-001 flag", () => {
    // When K+ < 3.0, CROSS-QT-HYPOK-001 escalates to critical on its own.
    // The consolidated output must keep that critical severity — we must
    // not lose the severity signal when suppressing the other flag.
    const flags = [criticalPotassium("critical"), qtHypoK("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out[0]!.severity).toBe("critical");
  });

  it("keeps CRITICAL-LAB-POTASSIUM when CROSS-QT-HYPOK-001 does NOT fire", () => {
    // Patient with K+ 2.8, no QT drug: only CRITICAL-LAB-POTASSIUM fires.
    // It must NOT be suppressed — that would silence a critical value.
    const flags = [criticalPotassium("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
  });

  it("is a no-op when CROSS-QT-HYPOK-001 fires alone (warning K+ 3.0-3.4)", () => {
    // Patient with K+ 3.2 on ondansetron: only CROSS-QT-HYPOK-001 fires
    // (K+ is not below the critical-values threshold of 3.0).
    // CRITICAL-LAB-POTASSIUM isn't in the batch, so nothing to suppress.
    const flags = [qtHypoK("warning")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-QT-HYPOK-001");
    expect(out[0]!.severity).toBe("warning");
  });

  it("preserves unrelated flags in the same batch", () => {
    // Consolidation must be narrow. Other concurrent flags (drug-interactions,
    // cross-specialty, etc.) must pass through untouched.
    const unrelated = ruleFlag({
      rule_id: "ONCO-VTE-NEURO-001",
      category: "cross-specialty",
      summary: "Cancer + VTE + new neuro symptom — stroke risk",
    });
    const flags = [criticalPotassium("critical"), qtHypoK("critical"), unrelated];
    const out = consolidateRuleFlags(flags);
    expect(out.map((f) => f.rule_id).sort()).toEqual(
      ["CROSS-QT-HYPOK-001", "ONCO-VTE-NEURO-001"].sort(),
    );
  });

  it("does NOT suppress other CRITICAL-LAB-* analytes when CROSS-QT-HYPOK-001 fires", () => {
    // The suppression is specific to potassium. A critical troponin that
    // happens to appear alongside a QT-HYPOK flag must still be emitted —
    // they describe unrelated signals.
    const troponin = ruleFlag({
      rule_id: "CRITICAL-LAB-TROPONIN_I",
      severity: "critical",
      category: "critical-value",
      summary: "Critical Troponin I: 0.8 ng/mL",
    });
    const flags = [troponin, qtHypoK("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.rule_id).sort()).toEqual(
      ["CRITICAL-LAB-TROPONIN_I", "CROSS-QT-HYPOK-001"].sort(),
    );
  });

  it("returns an empty array untouched", () => {
    expect(consolidateRuleFlags([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const flags = [criticalPotassium("critical"), qtHypoK("critical")];
    const snapshot = flags.map((f) => ({ ...f }));
    consolidateRuleFlags(flags);
    expect(flags).toEqual(snapshot);
  });

  it("suppresses all CRITICAL-LAB-POTASSIUM duplicates when QT-HYPOK fires (defense in depth)", () => {
    // Unlikely in practice — the rule only fires once per review pass —
    // but the consolidation must not leave one behind if the upstream
    // layer somehow emits two.
    const flags = [
      criticalPotassium("critical"),
      criticalPotassium("critical"),
      qtHypoK("critical"),
    ];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-QT-HYPOK-001");
  });
});

describe("consolidateRuleFlags — CRITICAL-LAB-POTASSIUM / CROSS-THIAZIDE-HYPOK-001 dedup (#878)", () => {
  it("suppresses CRITICAL-LAB-POTASSIUM when CROSS-THIAZIDE-HYPOK-001 also fires", () => {
    // Patient with K+ 2.8 on HCTZ (no QT drug): both flags describe the
    // same severe-hypokalemia signal; the thiazide flag is more actionable
    // because it names the diuretic class. Drop the critical-value flag.
    const flags = [criticalPotassium("critical"), thiazideHypoK("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-THIAZIDE-HYPOK-001");
    expect(out[0]!.severity).toBe("critical");
  });

  it("suppression is ordering-independent for thiazide dedup", () => {
    const flags = [thiazideHypoK("critical"), criticalPotassium("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-THIAZIDE-HYPOK-001");
  });

  it("preserves both CROSS-QT-HYPOK-001 and CROSS-THIAZIDE-HYPOK-001 when they co-fire", () => {
    // Patient with K+ 2.8 on ondansetron (QT drug) + HCTZ (thiazide):
    // both cross-specialty rules describe distinct mechanisms (torsades
    // risk vs. electrolyte worsening) and drive different actions, so
    // both must survive consolidation. Only the generic critical-value
    // potassium flag is suppressed.
    const flags = [
      criticalPotassium("critical"),
      qtHypoK("critical"),
      thiazideHypoK("critical"),
    ];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.rule_id).sort()).toEqual(
      ["CROSS-QT-HYPOK-001", "CROSS-THIAZIDE-HYPOK-001"].sort(),
    );
  });

  it("suppresses CRITICAL-LAB-POTASSIUM when only THIAZIDE-HYPOK (no QT-HYPOK) fires", () => {
    // Regression case for the broadened dedup predicate — previous
    // implementation only checked CROSS-QT-HYPOK-001.
    const flags = [thiazideHypoK("warning"), criticalPotassium("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CROSS-THIAZIDE-HYPOK-001");
  });

  it("keeps CRITICAL-LAB-POTASSIUM when neither hypoK cross-specialty rule fires", () => {
    // Regression: the original #854 invariant must still hold under the
    // broadened predicate.
    const flags = [criticalPotassium("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
  });

  it("does not mutate the input array under the broadened predicate", () => {
    const flags = [criticalPotassium("critical"), thiazideHypoK("critical")];
    const snapshot = flags.map((f) => ({ ...f }));
    consolidateRuleFlags(flags);
    expect(flags).toEqual(snapshot);
  });

  it("does NOT suppress other CRITICAL-LAB-* analytes when only THIAZIDE-HYPOK fires", () => {
    // Parallel to the QT-HYPOK troponin test — suppression stays narrow.
    const troponin = ruleFlag({
      rule_id: "CRITICAL-LAB-TROPONIN_I",
      severity: "critical",
      category: "critical-value",
      summary: "Critical Troponin I: 0.8 ng/mL",
    });
    const flags = [troponin, thiazideHypoK("critical")];
    const out = consolidateRuleFlags(flags);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.rule_id).sort()).toEqual(
      ["CRITICAL-LAB-TROPONIN_I", "CROSS-THIAZIDE-HYPOK-001"].sort(),
    );
  });
});
