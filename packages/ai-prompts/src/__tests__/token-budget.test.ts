import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  enforceTokenBudget,
  DEFAULT_TOKEN_BUDGET,
} from "../token-budget.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1); // rounds up
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles longer text proportionally", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

describe("DEFAULT_TOKEN_BUDGET", () => {
  it("is 150k tokens", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(150_000);
  });
});

describe("enforceTokenBudget", () => {
  it("returns prompt unchanged when under budget", () => {
    const prompt = "Short prompt";
    const result = enforceTokenBudget(prompt, 1000);

    expect(result.truncated).toBe(false);
    expect(result.prompt).toBe(prompt);
    expect(result.originalTokens).toBe(estimateTokens(prompt));
    expect(result.finalTokens).toBe(estimateTokens(prompt));
    expect(result.sectionsRemoved).toEqual([]);
  });

  it("trims lab results first when over budget", () => {
    const labs = Array.from({ length: 20 }, (_, i) =>
      `  - Lab Test ${i}: ${i * 10} mg/dL [HIGH] (2026-01-${String(i + 1).padStart(2, "0")})`
    ).join("\n");

    const prompt = `PATIENT CLINICAL CONTEXT
========================

Demographics: 65 year old Male

Active Diagnoses:
  - Cancer

Allergies:
  - NKDA

Active Medications:
  - Aspirin 81mg PO daily (since 2025-01-01)

Latest Vitals:
  - BP: 120 mmHg (2026-01-01)

Recent Lab Results:
${labs}

Care Team:
  - Dr. Smith (Oncology)

Recent Open Flags:
  None

TRIGGERING EVENT
================
Type: lab.created
Summary: New lab result
Detail:
Platelet count 45,000`;

    // Set budget just below the full prompt size
    const fullTokens = estimateTokens(prompt);
    const tightBudget = fullTokens - 20;

    const result = enforceTokenBudget(prompt, tightBudget);

    expect(result.truncated).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(tightBudget);
    expect(result.sectionsRemoved).toContain("recent_labs (trimmed to 5)");
  });

  it("hard-truncates as last resort while preserving triggering event", () => {
    const filler = "x".repeat(2000);
    const prompt = `Context data: ${filler}

TRIGGERING EVENT
================
Type: vital.created
Summary: Critical vital sign
Detail:
Blood pressure 200/120 mmHg`;

    // Very tight budget
    const result = enforceTokenBudget(prompt, 200);

    expect(result.truncated).toBe(true);
    expect(result.prompt).toContain("TRIGGERING EVENT");
    expect(result.prompt).toContain("Blood pressure 200/120 mmHg");
    expect(result.sectionsRemoved).toContain("hard_truncation");
  });

  it("returns exact budget boundary without truncation", () => {
    // Create a prompt of exactly the budget size
    const budget = 100;
    const text = "a".repeat(budget * 4); // exactly budget tokens
    const result = enforceTokenBudget(text, budget);

    expect(result.truncated).toBe(false);
    expect(result.prompt).toBe(text);
  });

  it("records original and final token counts", () => {
    const longText = "a".repeat(10000);
    const prompt = `Recent Lab Results:\n${longText}\n\nTRIGGERING EVENT\n================\nType: test\nSummary: test\nDetail:\ntest`;

    const result = enforceTokenBudget(prompt, 500);

    expect(result.originalTokens).toBeGreaterThan(500);
    expect(result.finalTokens).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
  });
});
