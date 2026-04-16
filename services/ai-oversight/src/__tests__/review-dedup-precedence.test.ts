import { describe, it, expect } from "vitest";
import type { LLMFlagOutput } from "@carebridge/ai-prompts";
import {
  shouldDropAsDuplicate,
  severityRank,
  categoryRank,
} from "../services/review-service.js";
import type { RuleFlag } from "../rules/critical-values.js";

function ruleFlag(overrides: Partial<RuleFlag> = {}): RuleFlag {
  return {
    rule_id: "TEST-RULE-001",
    severity: "warning",
    category: "cross-specialty",
    summary: "Cancer patient with VTE presents with new neurological symptom",
    rationale: "",
    suggested_action: "",
    notify_specialties: ["oncology"],
    ...overrides,
  } as RuleFlag;
}

function llm(overrides: Partial<LLMFlagOutput> = {}): LLMFlagOutput {
  return {
    severity: "warning",
    category: "cross-specialty",
    summary: "Cancer patient with VTE presents with new neurological symptom",
    rationale: "",
    suggested_action: "",
    notify_specialties: ["oncology"],
    ...overrides,
  } as LLMFlagOutput;
}

describe("severityRank", () => {
  it("orders critical > warning > info", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
  });
  it("treats unknown as lowest", () => {
    expect(severityRank("bogus")).toBe(0);
  });
});

describe("categoryRank", () => {
  it("orders critical-value > medication-safety > cross-specialty > clinical-alert > care-gap", () => {
    expect(categoryRank("critical-value")).toBeGreaterThan(
      categoryRank("medication-safety"),
    );
    expect(categoryRank("medication-safety")).toBeGreaterThan(
      categoryRank("cross-specialty"),
    );
    expect(categoryRank("cross-specialty")).toBeGreaterThan(
      categoryRank("clinical-alert"),
    );
    expect(categoryRank("clinical-alert")).toBeGreaterThan(
      categoryRank("care-gap"),
    );
  });
});

describe("shouldDropAsDuplicate — #266 precedence", () => {
  it("drops a fully subsumed LLM finding", () => {
    const rf = ruleFlag();
    const finding = llm();
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(true);
  });

  it("keeps an LLM finding that escalates severity (warning → critical)", () => {
    const rf = ruleFlag({ severity: "warning" });
    const finding = llm({ severity: "critical" });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("never drops a critical LLM finding regardless of overlap", () => {
    const rf = ruleFlag({ severity: "critical" });
    const finding = llm({
      severity: "critical",
      summary: "Cancer patient with VTE presents with new neurological symptom",
    });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("keeps an LLM finding that adds a new notify specialty", () => {
    const rf = ruleFlag({ notify_specialties: ["oncology"] });
    const finding = llm({ notify_specialties: ["oncology", "neurology"] });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("keeps an LLM finding that upgrades the category", () => {
    const rf = ruleFlag({ category: "care-gap" });
    const finding = llm({ category: "medication-safety" });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("keeps an LLM finding with low word overlap (distinct concept)", () => {
    const rf = ruleFlag({ summary: "Critical potassium value 7.2 mmol/L" });
    const finding = llm({
      summary: "Patient reports chest pain with radiation to left arm",
    });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("keeps a finding when overlap is between 0.40 and 0.60 — previously falsely dropped", () => {
    // These share some words but describe distinct concepts; the old 40%
    // threshold would call this a duplicate.
    const rf = ruleFlag({
      summary: "Cancer patient presents with new symptom requiring review",
    });
    const finding = llm({
      summary:
        "Elderly patient with new unexplained fever and recent immunotherapy review",
    });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(false);
  });

  it("considers every rule flag — dropped if ANY rule fully subsumes it", () => {
    const rf1 = ruleFlag({ summary: "Unrelated lab value abnormal" });
    const rf2 = ruleFlag(); // default — same topic as the LLM finding
    const finding = llm();
    expect(shouldDropAsDuplicate(finding, [rf1, rf2])).toBe(true);
  });

  it("keeps an LLM finding when the matching rule has ALL new value signals but LLM does not", () => {
    // Sanity: rule flag notifying broader specialties than LLM — LLM still
    // contains no new info, should be dropped.
    const rf = ruleFlag({
      notify_specialties: ["oncology", "neurology", "emergency"],
    });
    const finding = llm({ notify_specialties: ["oncology"] });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(true);
  });

  it("does not crash on empty rule-flag list", () => {
    expect(shouldDropAsDuplicate(llm(), [])).toBe(false);
  });

  it("does not crash on missing notify_specialties", () => {
    const rf = ruleFlag({ notify_specialties: [] });
    const finding = llm({ notify_specialties: [] });
    expect(shouldDropAsDuplicate(finding, [rf])).toBe(true);
  });
});
