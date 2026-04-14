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
