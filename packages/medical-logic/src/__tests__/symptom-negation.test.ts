import { describe, it, expect } from "vitest";

import { hasUnnegatedMention } from "../symptom-negation.js";

describe("hasUnnegatedMention — positive matches", () => {
  it("returns true for the bare term", () => {
    expect(hasUnnegatedMention("fever", "fever")).toBe(true);
  });

  it("returns true for the term in a positive sentence", () => {
    expect(hasUnnegatedMention("reports fever and chills", "fever")).toBe(true);
  });

  it("returns true for the term embedded in a positive HPI", () => {
    expect(
      hasUnnegatedMention(
        "Patient presents with fever 101.5 starting yesterday morning.",
        "fever",
      ),
    ).toBe(true);
  });

  it("is case-insensitive for both haystack and needle", () => {
    expect(hasUnnegatedMention("Reports FEVER overnight", "Fever")).toBe(true);
  });

  it("matches multi-word terms", () => {
    expect(
      hasUnnegatedMention("Patient has neck stiffness", "neck stiffness"),
    ).toBe(true);
  });

  it("returns true when one mention is negated but another later mention is positive", () => {
    expect(
      hasUnnegatedMention(
        "No fever on admission; now reports fever 102 overnight.",
        "fever",
      ),
    ).toBe(true);
  });

  it("returns true when the negation marker is further than the lookback window", () => {
    // "no" is well outside the ~5-token window before "fever".
    expect(
      hasUnnegatedMention(
        "No headache, no nausea, no vomiting, no chest pain at admission. Six hours later the nurse charted fever 102.",
        "fever",
      ),
    ).toBe(true);
  });
});

describe("hasUnnegatedMention — negation forms", () => {
  it("'no <term>' is negated", () => {
    expect(hasUnnegatedMention("no fever", "fever")).toBe(false);
  });

  it("'denies <term>' is negated", () => {
    expect(hasUnnegatedMention("patient denies fever", "fever")).toBe(false);
  });

  it("'without <term>' is negated", () => {
    expect(
      hasUnnegatedMention("admitted without fever or chills", "fever"),
    ).toBe(false);
  });

  it("'absent <term>' is negated", () => {
    expect(hasUnnegatedMention("fever absent on exam", "fever")).toBe(false);
  });

  it("'absence of <term>' is negated", () => {
    expect(
      hasUnnegatedMention("notable for the absence of fever", "fever"),
    ).toBe(false);
  });

  it("'negative for <term>' is negated", () => {
    expect(
      hasUnnegatedMention("ROS negative for fever, chills, nausea", "fever"),
    ).toBe(false);
  });

  it("'<term>-free' is negated", () => {
    expect(hasUnnegatedMention("patient is fever-free x 24h", "fever")).toBe(
      false,
    );
  });

  it("'no h/o <term>' is negated", () => {
    expect(hasUnnegatedMention("no h/o fever", "fever")).toBe(false);
  });

  it("'no history of <term>' is negated", () => {
    expect(
      hasUnnegatedMention("no history of fever or weight loss", "fever"),
    ).toBe(false);
  });

  it("'not <term>' is negated", () => {
    expect(hasUnnegatedMention("patient is not febrile", "febrile")).toBe(
      false,
    );
  });
});

describe("hasUnnegatedMention — comma-separated list of negatives", () => {
  it("treats each comma-separated item as inheriting the leading 'no'", () => {
    // Reproduction case from issue #1307.
    const hpi =
      "No prior headache history of this severity, no migraine history, no recent head trauma, no fever, no neck stiffness, no nausea or vomiting.";
    expect(hasUnnegatedMention(hpi, "fever")).toBe(false);
    expect(hasUnnegatedMention(hpi, "neck stiffness")).toBe(false);
    expect(hasUnnegatedMention(hpi, "nausea")).toBe(false);
  });

  it("does not negate later positive findings just because an earlier item was negated", () => {
    const hpi = "No fever. Reports headache 8/10.";
    expect(hasUnnegatedMention(hpi, "fever")).toBe(false);
    expect(hasUnnegatedMention(hpi, "headache")).toBe(true);
  });

  it("handles ROS-style 'negative for X, Y, Z' lists", () => {
    const ros = "ROS negative for fever, chills, night sweats, weight loss.";
    expect(hasUnnegatedMention(ros, "fever")).toBe(false);
    expect(hasUnnegatedMention(ros, "chills")).toBe(false);
    expect(hasUnnegatedMention(ros, "night sweats")).toBe(false);
    expect(hasUnnegatedMention(ros, "weight loss")).toBe(false);
  });
});

describe("hasUnnegatedMention — edge cases", () => {
  it("returns false when the term is absent", () => {
    expect(hasUnnegatedMention("patient reports headache", "fever")).toBe(
      false,
    );
  });

  it("returns false on empty haystack", () => {
    expect(hasUnnegatedMention("", "fever")).toBe(false);
  });

  it("returns false on empty term", () => {
    expect(hasUnnegatedMention("some text", "")).toBe(false);
  });

  it("does not match the term as a substring of another word", () => {
    // 'fevered' should match (same lemma), but 'feverfew' (an herb) should not.
    // For the simple word-boundary version we match whole-word only.
    expect(hasUnnegatedMention("taking feverfew tea", "fever")).toBe(false);
  });
});
