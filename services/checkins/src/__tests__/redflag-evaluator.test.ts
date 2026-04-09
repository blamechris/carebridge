/**
 * Phase B1 — unit tests for the red-flag evaluator.
 *
 * Pure function, no mocking. Covers each red_flag `kind` discriminator
 * (bool / threshold / values) plus the defensive fallbacks.
 */
import { describe, it, expect } from "vitest";
import type { CheckInQuestion } from "@carebridge/validators";
import { evaluateRedFlagHits } from "../services/redflag-evaluator.js";

function q(overrides: Partial<CheckInQuestion>): CheckInQuestion {
  return {
    id: "q1",
    prompt: "Test",
    type: "boolean",
    ...overrides,
  } as CheckInQuestion;
}

describe("evaluateRedFlagHits — bool", () => {
  const questions: CheckInQuestion[] = [
    q({
      id: "fever",
      type: "boolean",
      red_flag: { kind: "bool", when: true },
    }),
  ];

  it("fires when answer matches the red-flag value", () => {
    expect(evaluateRedFlagHits(questions, { fever: true })).toEqual(["fever"]);
  });

  it("does not fire when answer is the opposite", () => {
    expect(evaluateRedFlagHits(questions, { fever: false })).toEqual([]);
  });

  it("does not fire on a non-boolean answer", () => {
    expect(evaluateRedFlagHits(questions, { fever: "yes" })).toEqual([]);
  });

  it("does not fire when the answer is missing", () => {
    expect(evaluateRedFlagHits(questions, {})).toEqual([]);
  });
});

describe("evaluateRedFlagHits — threshold", () => {
  it("fires on gte", () => {
    const questions = [
      q({
        id: "pain",
        type: "scale",
        red_flag: { kind: "threshold", gte: 8 },
      }),
    ];
    expect(evaluateRedFlagHits(questions, { pain: 8 })).toEqual(["pain"]);
    expect(evaluateRedFlagHits(questions, { pain: 9 })).toEqual(["pain"]);
    expect(evaluateRedFlagHits(questions, { pain: 7 })).toEqual([]);
  });

  it("fires on lte", () => {
    const questions = [
      q({
        id: "o2",
        type: "number",
        red_flag: { kind: "threshold", lte: 90 },
      }),
    ];
    expect(evaluateRedFlagHits(questions, { o2: 88 })).toEqual(["o2"]);
    expect(evaluateRedFlagHits(questions, { o2: 90 })).toEqual(["o2"]);
    expect(evaluateRedFlagHits(questions, { o2: 95 })).toEqual([]);
  });

  it("fires only when both gte and lte are satisfied", () => {
    const questions = [
      q({
        id: "range",
        type: "number",
        red_flag: { kind: "threshold", gte: 10, lte: 20 },
      }),
    ];
    expect(evaluateRedFlagHits(questions, { range: 15 })).toEqual(["range"]);
    expect(evaluateRedFlagHits(questions, { range: 5 })).toEqual([]);
    expect(evaluateRedFlagHits(questions, { range: 25 })).toEqual([]);
  });

  it("never matches when neither gte nor lte are defined", () => {
    const questions = [
      q({
        id: "x",
        type: "number",
        // intentionally empty threshold
        red_flag: { kind: "threshold" },
      }),
    ];
    expect(evaluateRedFlagHits(questions, { x: 0 })).toEqual([]);
    expect(evaluateRedFlagHits(questions, { x: 1000 })).toEqual([]);
  });

  it("does not fire on non-numeric answer", () => {
    const questions = [
      q({
        id: "pain",
        type: "scale",
        red_flag: { kind: "threshold", gte: 8 },
      }),
    ];
    expect(evaluateRedFlagHits(questions, { pain: "8" })).toEqual([]);
  });
});

describe("evaluateRedFlagHits — values", () => {
  const questions = [
    q({
      id: "symptoms",
      type: "multi",
      red_flag: {
        kind: "values",
        values: ["fever", "bleeding"],
      },
    }),
  ];

  it("fires on single string match", () => {
    const singleQ = [
      q({
        id: "wound",
        type: "select",
        red_flag: { kind: "values", values: ["severe"] },
      }),
    ];
    expect(evaluateRedFlagHits(singleQ, { wound: "severe" })).toEqual([
      "wound",
    ]);
    expect(evaluateRedFlagHits(singleQ, { wound: "none" })).toEqual([]);
  });

  it("fires on array containing at least one matching value", () => {
    expect(
      evaluateRedFlagHits(questions, { symptoms: ["fatigue", "fever"] }),
    ).toEqual(["symptoms"]);
  });

  it("does not fire on array with no matches", () => {
    expect(
      evaluateRedFlagHits(questions, { symptoms: ["fatigue", "thirst"] }),
    ).toEqual([]);
  });

  it("does not fire on boolean answer", () => {
    expect(evaluateRedFlagHits(questions, { symptoms: true })).toEqual([]);
  });
});

describe("evaluateRedFlagHits — stability", () => {
  it("preserves declared question order in the output", () => {
    const questions = [
      q({
        id: "a",
        type: "boolean",
        red_flag: { kind: "bool", when: true },
      }),
      q({
        id: "b",
        type: "boolean",
        red_flag: { kind: "bool", when: true },
      }),
      q({
        id: "c",
        type: "boolean",
        red_flag: { kind: "bool", when: true },
      }),
    ];
    // Responses in reverse order — output must still be a,b,c
    expect(evaluateRedFlagHits(questions, { c: true, b: true, a: true }))
      .toEqual(["a", "b", "c"]);
  });

  it("ignores questions with no red_flag", () => {
    const questions = [
      q({ id: "no_rf", type: "boolean" }),
      q({
        id: "has_rf",
        type: "boolean",
        red_flag: { kind: "bool", when: true },
      }),
    ];
    expect(
      evaluateRedFlagHits(questions, { no_rf: true, has_rf: true }),
    ).toEqual(["has_rf"]);
  });
});
