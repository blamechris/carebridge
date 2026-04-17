import { describe, it, expect } from "vitest";
import {
  CLINICAL_REVIEW_SYSTEM_PROMPT,
  PROMPT_VERSION,
} from "../clinical-review.js";
import {
  DRUG_CLASS_CROSS_REACTIONS,
  renderDrugClassAnchors,
} from "../drug-class-anchors.js";

describe("CLINICAL_REVIEW_SYSTEM_PROMPT", () => {
  it("explicitly instructs the LLM to check drug-allergy contraindications", () => {
    // The prompt must tell the LLM to cross-check active_medications against
    // the allergies list. Prior versions only passed allergies in context
    // and hoped the model would catch conflicts — this issue's reason for
    // existing (#255).
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toMatch(
      /active medications that match or cross-react[\s\S]*allergies/i,
    );
  });

  it("names common cross-reacting allergy classes", () => {
    // Naming the common classes in-prompt gives the LLM concrete retrieval
    // anchors; without them the instruction is too abstract to reliably act
    // on.
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain("penicillin");
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain("sulfa");
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain("aspirin");
  });

  it("renders every drug class example from DRUG_CLASS_CROSS_REACTIONS into the prompt", () => {
    for (const reaction of DRUG_CLASS_CROSS_REACTIONS) {
      expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain(reaction.class);
      for (const example of reaction.examples) {
        expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain(example);
      }
    }
  });

  it("includes hallucination guardrails for uncertain interactions", () => {
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toMatch(
      /if you are uncertain[\s\S]*do NOT flag/i,
    );
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toMatch(
      /standard medical references/i,
    );
  });

  it("preserves the unknown-allergy-status handling", () => {
    // When the patient has allergy_status = "unknown" the LLM must not
    // treat an empty allergies array as NKDA.
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toMatch(
      /allergy_status.*unknown/i,
    );
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain("NKDA");
  });

  it("lists medication-safety as a permitted category", () => {
    // The allergy-medication finding should use medication-safety. If the
    // category isn't listed, the validator rejects the response.
    expect(CLINICAL_REVIEW_SYSTEM_PROMPT).toContain("medication-safety");
  });

  it("bumps PROMPT_VERSION off 1.0.x when the prompt changes materially", () => {
    // Guard against silently mutating the prompt without advancing the
    // version string — audit trail of which prompt produced a given flag
    // depends on PROMPT_VERSION uniquely identifying the prompt text.
    expect(PROMPT_VERSION).not.toBe("1.0.0");
  });
});

describe("renderDrugClassAnchors", () => {
  it("produces a semicolon-separated list of class cross-reactions", () => {
    const rendered = renderDrugClassAnchors();
    expect(rendered).toContain("penicillin allergy cross-reacts with amoxicillin, ampicillin, piperacillin");
    expect(rendered).toContain("sulfa allergy cross-reacts with sulfonamide antibiotics");
    expect(rendered).toContain("aspirin allergy cross-reacts with other NSAIDs");
    // Entries are joined with semicolons
    expect(rendered.split(";").length).toBe(DRUG_CLASS_CROSS_REACTIONS.length);
  });
});
