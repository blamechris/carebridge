import { describe, it, expect } from "vitest";
import {
  loadFixtures,
  evaluateFixture,
  evalFixtureSchema,
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

describe("golden-eval: Zod schema validation", () => {
  it("rejects a fixture missing required fields with a clear error", () => {
    const malformed = {
      id: "bad-fixture",
      description: "missing context and expected",
    };
    const result = evalFixtureSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("context");
      expect(paths).toContain("expected");
    }
  });

  it("rejects a fixture with an invalid minimumSeverity value", () => {
    const malformed = {
      id: "bad-severity",
      description: "invalid severity enum",
      context: {
        patient: {
          age: 40,
          sex: "female",
          active_diagnoses: [],
          allergies: [],
        },
        active_medications: [],
        latest_vitals: {},
        triggering_event: { type: "test", summary: "s", detail: "d" },
        recent_flags: [],
        care_team: [],
      },
      expected: {
        shouldFlag: true,
        minimumSeverity: "urgent",
        mustMentionInPrompt: [],
      },
    };
    const result = evalFixtureSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const severityIssue = result.error.issues.find((i) =>
        i.path.includes("minimumSeverity"),
      );
      expect(severityIssue).toBeDefined();
    }
  });

  it("rejects a fixture with wrong type for shouldFlag", () => {
    const malformed = {
      id: "bad-flag",
      description: "shouldFlag is a string",
      context: {
        patient: {
          age: 50,
          sex: "male",
          active_diagnoses: [],
          allergies: [],
        },
        active_medications: [],
        latest_vitals: {},
        triggering_event: { type: "test", summary: "s", detail: "d" },
        recent_flags: [],
        care_team: [],
      },
      expected: {
        shouldFlag: "yes",
        mustMentionInPrompt: [],
      },
    };
    const result = evalFixtureSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const flagIssue = result.error.issues.find((i) =>
        i.path.includes("shouldFlag"),
      );
      expect(flagIssue).toBeDefined();
    }
  });

  it("accepts a valid fixture without errors", () => {
    const valid = {
      id: "valid-fixture",
      description: "a well-formed fixture",
      context: {
        patient: {
          age: 55,
          sex: "male",
          allergy_status: "nkda" as const,
          active_diagnoses: ["Hypertension"],
          allergies: [],
        },
        active_medications: [
          {
            name: "Lisinopril",
            dose: "10 mg",
            route: "oral",
            frequency: "daily",
            started_at: "2026-01-01",
          },
        ],
        latest_vitals: {},
        triggering_event: {
          type: "lab_result",
          summary: "Routine labs",
          detail: "Normal results",
        },
        recent_flags: [],
        care_team: [{ name: "Dr. Test", specialty: "Internal Medicine" }],
      },
      expected: {
        shouldFlag: false,
        mustMentionInPrompt: ["Hypertension"],
      },
    };
    const result = evalFixtureSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});
