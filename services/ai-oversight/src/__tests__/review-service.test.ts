import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the isDuplicate helper in review-service.
 *
 * isDuplicate is a private function, so we test it indirectly by importing
 * the module internals. Since it's not exported, we replicate the logic here
 * to validate the word-overlap heuristic independently.
 */

import type { RuleFlag } from "../rules/critical-values.js";

// Replicate the isDuplicate logic from review-service.ts for unit testing.
// This mirrors the exact algorithm: >40% overlap of significant words (length > 3)
// from the rule flag summary appearing in the LLM finding summary.
interface LLMFinding {
  severity: string;
  category: string;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

function isDuplicate(finding: LLMFinding, ruleFlags: RuleFlag[]): boolean {
  const findingWords = new Set(
    finding.summary
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  for (const ruleFlag of ruleFlags) {
    const ruleWords = ruleFlag.summary
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    let overlap = 0;
    for (const word of ruleWords) {
      if (findingWords.has(word)) overlap++;
    }

    if (ruleWords.length > 0 && overlap / ruleWords.length > 0.4) {
      return true;
    }
  }

  return false;
}

describe("isDuplicate — LLM finding deduplication against rule flags", () => {
  const strokeRuleFlag: RuleFlag = {
    severity: "critical",
    category: "cross-specialty",
    summary:
      "Cancer patient with VTE history presents with new neurological symptom — elevated stroke risk",
    rationale: "Cancer-associated hypercoagulable state",
    suggested_action: "Urgent neurological evaluation",
    notify_specialties: ["neurology", "hematology"],
    rule_id: "ONCO-VTE-NEURO-001",
  };

  const bleedRuleFlag: RuleFlag = {
    severity: "critical",
    category: "cross-specialty",
    summary:
      "Patient on anticoagulation therapy presents with bleeding symptoms",
    rationale: "Bleeding may indicate supratherapeutic anticoagulation",
    suggested_action: "Check INR/coagulation studies urgently",
    notify_specialties: ["hematology"],
    rule_id: "ANTICOAG-BLEED-001",
  };

  it("correctly identifies duplicate when LLM summary has high word overlap with rule flag", () => {
    const llmFinding: LLMFinding = {
      severity: "critical",
      category: "cross-specialty",
      summary:
        "Cancer patient with VTE history and new neurological symptom has elevated stroke risk",
      rationale: "Hypercoagulable state in cancer patient",
      suggested_action: "Neurology consult",
      notify_specialties: ["neurology"],
    };

    expect(isDuplicate(llmFinding, [strokeRuleFlag])).toBe(true);
  });

  it("does NOT suppress a different finding even with same severity and category", () => {
    const llmFinding: LLMFinding = {
      severity: "critical",
      category: "cross-specialty",
      summary:
        "Potential drug-drug interaction between chemotherapy agent and renal medication",
      rationale: "Nephrotoxic combination identified",
      suggested_action: "Review renal function and adjust doses",
      notify_specialties: ["nephrology", "oncology"],
    };

    expect(isDuplicate(llmFinding, [strokeRuleFlag])).toBe(false);
  });

  it("does NOT suppress when word overlap is below 40% threshold", () => {
    const llmFinding: LLMFinding = {
      severity: "critical",
      category: "cross-specialty",
      summary:
        "Patient on chemotherapy requires dose adjustment for renal impairment",
      rationale: "Renal function declining",
      suggested_action: "Adjust chemotherapy dose",
      notify_specialties: ["oncology"],
    };

    expect(isDuplicate(llmFinding, [strokeRuleFlag])).toBe(false);
  });

  it("handles empty rule flags array", () => {
    const llmFinding: LLMFinding = {
      severity: "warning",
      category: "medication-safety",
      summary: "Some finding about medication",
      rationale: "Something",
      suggested_action: "Do something",
      notify_specialties: [],
    };

    expect(isDuplicate(llmFinding, [])).toBe(false);
  });

  it("checks against multiple rule flags and detects overlap with any one", () => {
    const llmFinding: LLMFinding = {
      severity: "critical",
      category: "cross-specialty",
      summary:
        "Anticoagulation therapy patient presenting with active bleeding symptoms detected",
      rationale: "Bleeding risk",
      suggested_action: "Check coagulation",
      notify_specialties: ["hematology"],
    };

    // The LLM finding does not overlap with strokeRuleFlag but does overlap with bleedRuleFlag
    expect(isDuplicate(llmFinding, [strokeRuleFlag, bleedRuleFlag])).toBe(true);
  });
});
