import { describe, it, expect } from "vitest";
import {
  loadFixtures,
  evaluateFixture,
  type EvalFixture,
} from "../../evals/eval-runner.js";
import { buildReviewPrompt } from "../clinical-review.js";
import {
  estimateTokens,
  enforceTokenBudget,
  DEFAULT_TOKEN_BUDGET,
} from "../token-budget.js";
import { PROMPT_SECTIONS } from "../prompt-sections.js";

const fixtures = loadFixtures();

describe("golden-eval: fixture loading", () => {
  it("loads all six fixture files", () => {
    expect(fixtures.length).toBe(6);
  });

  it("each fixture has a unique id", () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each fixture has valid expected shape", () => {
    for (const fixture of fixtures) {
      expect(fixture.expected).toBeDefined();
      expect(typeof fixture.expected.shouldFlag).toBe("boolean");
      expect(Array.isArray(fixture.expected.mustMentionInPrompt)).toBe(true);
    }
  });
});

describe("golden-eval: prompt structure", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — prompt contains all required section headers",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);

      expect(prompt).toContain("PATIENT CLINICAL CONTEXT");
      expect(prompt).toContain(PROMPT_SECTIONS.DEMOGRAPHICS);
      expect(prompt).toContain(PROMPT_SECTIONS.DIAGNOSES);
      expect(prompt).toContain(PROMPT_SECTIONS.ALLERGIES);
      expect(prompt).toContain(PROMPT_SECTIONS.MEDICATIONS);
      expect(prompt).toContain(PROMPT_SECTIONS.TRIGGERING_EVENT);
    },
  );

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — prompt includes all expected clinical data",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);

      for (const mention of fixture.expected.mustMentionInPrompt) {
        expect(prompt).toContain(mention);
      }
    },
  );

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — prompt includes all active medications",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);

      for (const med of fixture.context.active_medications) {
        expect(prompt).toContain(med.name);
        expect(prompt).toContain(med.dose);
      }
    },
  );

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — prompt includes triggering event details",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);

      expect(prompt).toContain(fixture.context.triggering_event.summary);
      expect(prompt).toContain(fixture.context.triggering_event.detail);
    },
  );
});

describe("golden-eval: token budget compliance", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — prompt is within default token budget",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);
      const tokens = estimateTokens(prompt);

      expect(tokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
    },
  );

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — enforceTokenBudget does not truncate within-budget prompts",
    (_id, fixture) => {
      const prompt = buildReviewPrompt(fixture.context);
      const result = enforceTokenBudget(prompt);

      expect(result.truncated).toBe(false);
      expect(result.sectionsRemoved).toHaveLength(0);
      expect(result.prompt).toBe(prompt);
    },
  );
});

describe("golden-eval: allergy rendering", () => {
  it("NKDA patient shows confirmed no-known-drug-allergies text", () => {
    const nkdaFixture = fixtures.find(
      (f) => f.id === "nkda-patient-on-contrast",
    ) as EvalFixture;
    expect(nkdaFixture).toBeDefined();

    const prompt = buildReviewPrompt(nkdaFixture.context);
    expect(prompt).toContain("NKDA");
    expect(prompt).toContain("no known drug allergies");
  });

  it("unknown allergy status warns against assuming NKDA", () => {
    const unknownFixture = fixtures.find(
      (f) => f.id === "unknown-allergy-status-documentation-gap",
    ) as EvalFixture;
    expect(unknownFixture).toBeDefined();

    const prompt = buildReviewPrompt(unknownFixture.context);
    expect(prompt).toContain("ALLERGY STATUS UNKNOWN");
    expect(prompt).toContain("do NOT assume NKDA");
  });

  it("penicillin allergy with verification status appears in prompt", () => {
    const allergyFixture = fixtures.find(
      (f) => f.id === "penicillin-allergy-on-amoxicillin",
    ) as EvalFixture;
    expect(allergyFixture).toBeDefined();

    const prompt = buildReviewPrompt(allergyFixture.context);
    expect(prompt).toContain("Penicillin");
    expect(prompt).toContain("confirmed");
  });
});

describe("golden-eval: full evaluation pass", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))(
    "%s — passes full evaluation",
    (_id, fixture) => {
      const result = evaluateFixture(fixture);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.missingMentions).toHaveLength(0);
      expect(result.withinBudget).toBe(true);
    },
  );
});

describe("golden-eval: negative cases", () => {
  it("NKDA contrast fixture should not require medication-safety flags", () => {
    const fixture = fixtures.find(
      (f) => f.id === "nkda-patient-on-contrast",
    ) as EvalFixture;
    expect(fixture.expected.shouldFlag).toBe(false);
    expect(fixture.expected.forbiddenCategories).toContain("medication-safety");
  });

  it("ambiguous interaction fixture should not require drug-interaction flags", () => {
    const fixture = fixtures.find(
      (f) => f.id === "ambiguous-interaction-guardrail",
    ) as EvalFixture;
    expect(fixture.expected.shouldFlag).toBe(false);
    expect(fixture.expected.forbiddenCategories).toContain("drug-interaction");
    expect(fixture.expected.forbiddenCategories).toContain("medication-safety");
  });
});
