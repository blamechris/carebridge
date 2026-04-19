import { describe, it, expect } from "vitest";
import { checkAllergyMedication } from "./allergy-medication.js";
import type { PatientContext } from "./cross-specialty.js";

function makeContext(
  allergies: PatientContext["allergies"],
  medications: string[],
): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: medications,
    new_symptoms: [],
    care_team_specialties: [],
    allergies,
  };
}

describe("allergy-medication rule IDs", () => {
  it("produces unique rule IDs across all flags in a single invocation", () => {
    const ctx = makeContext(
      [
        { allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" },
        { allergen: "Sulfa", severity: "moderate", reaction: "rash" },
        { allergen: "Ibuprofen", severity: "mild", reaction: "hives" },
      ],
      [
        "Amoxicillin 500mg",
        "Cefazolin 1g",
        "Sulfamethoxazole 800mg",
        "Naproxen 500mg",
      ],
    );

    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);

    const ruleIds = flags.map((f) => f.rule_id);
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(ruleIds.length);
  });

  it("produces deterministic IDs across repeated calls", () => {
    const ctx = makeContext(
      [{ allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg"],
    );

    const first = checkAllergyMedication(ctx);
    const second = checkAllergyMedication(ctx);

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((f) => f.rule_id)).toEqual(second.map((f) => f.rule_id));
  });

  it("generates distinct IDs for direct vs cross-reactivity matches", () => {
    // Penicillin allergy with a penicillin drug (direct) vs cephalosporin (cross)
    const ctx = makeContext(
      [{ allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" }],
      ["Penicillin V 500mg", "Cefazolin 1g"],
    );

    const flags = checkAllergyMedication(ctx);
    const ruleIds = flags.map((f) => f.rule_id);
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(ruleIds.length);
  });

  it("returns no flags when no allergies are present", () => {
    const ctx = makeContext([], ["Amoxicillin 500mg"]);
    expect(checkAllergyMedication(ctx)).toHaveLength(0);
  });
});

describe("allergy-medication allergen normalization (#232)", () => {
  // Before #232, shorthand allergens never matched generic prescriptions
  // because the direct-match compare only looked at `allergen.toLowerCase()`
  // and the CROSS_REACTIVITY_MAP's allergen regex. PCN, Lovenox, ASA, APAP
  // slipped through. These cases lock the fix in.

  it("PCN allergy flags an amoxicillin prescription (direct class match)", () => {
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg PO q8h"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.summary).toMatch(/amoxicillin/i);
  });

  it("PCN allergy flags a cefazolin prescription via penicillin-cephalosporin cross-reactivity", () => {
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Cefazolin 1g IV"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    const summary = flags.map((f) => f.summary).join(" ");
    expect(summary).toMatch(/cross.?react|cefazolin/i);
  });

  it("Lovenox allergy flags an enoxaparin prescription", () => {
    const ctx = makeContext(
      [{ allergen: "Lovenox", severity: "severe", reaction: "HIT" }],
      ["Enoxaparin 40mg SQ daily"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("Sulfa allergy flags a sulfamethoxazole prescription", () => {
    const ctx = makeContext(
      [{ allergen: "Sulfa", severity: "moderate", reaction: "rash" }],
      ["Sulfamethoxazole-trimethoprim 800/160mg"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("ASA allergy flags ibuprofen via NSAID class (AERD coverage)", () => {
    const ctx = makeContext(
      [{ allergen: "ASA", severity: "moderate", reaction: "bronchospasm" }],
      ["Ibuprofen 400mg PO q6h"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.summary.toLowerCase()).toContain("ibuprofen");
  });

  it("APAP allergy flags a Tylenol prescription", () => {
    const ctx = makeContext(
      [{ allergen: "APAP", severity: "mild", reaction: "itch" }],
      ["Tylenol 500mg PO q6h PRN"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("ACE-I shorthand flags a lisinopril prescription", () => {
    const ctx = makeContext(
      [{ allergen: "ACE-I", severity: "moderate", reaction: "angioedema" }],
      ["Lisinopril 10mg PO daily"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("unknown allergen keeps existing behavior (pass-through)", () => {
    // Salmon isn't in our synonym table; no cross-reactive med should trip
    // the allergy-med rule spuriously.
    const ctx = makeContext(
      [{ allergen: "Salmon", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });
});
