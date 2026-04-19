/**
 * Allergy override suppression — regression tests for issue #233.
 *
 * `checkAllergyMedication` must suppress flags for allergy-drug pairs that
 * have already been formally overridden via `allergies.override`. The test
 * cases below enumerate the four scenarios that matter in practice:
 *   1. No overrides — flag still fires.
 *   2. Override referencing the same allergy_id AND medication -> suppressed.
 *   3. Override referencing the same allergy_id with NO recorded medication
 *      -> suppresses any medication for that allergen (ids win).
 *   4. Override for a DIFFERENT allergy_id -> does NOT suppress; each
 *      allergy-drug pair is reviewed separately.
 */
import { describe, it, expect } from "vitest";
import { checkAllergyMedication } from "./allergy-medication.js";
import type {
  PatientContext,
  ResolvedAllergyOverride,
} from "./cross-specialty.js";

const PENICILLIN_ALLERGY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SULFA_ALLERGY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeContext(
  overrides: ResolvedAllergyOverride[] | undefined,
): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: ["Amoxicillin 500mg"],
    new_symptoms: [],
    care_team_specialties: [],
    allergies: [
      {
        id: PENICILLIN_ALLERGY_ID,
        allergen: "Penicillin",
        severity: "severe",
        reaction: "anaphylaxis",
      },
    ],
    resolved_overrides: overrides,
  };
}

describe("checkAllergyMedication — override suppression (issue #233)", () => {
  it("still flags when no overrides are present", () => {
    const flags = checkAllergyMedication(makeContext(undefined));
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.summary).toMatch(/Amoxicillin/);
  });

  it("suppresses the flag when a matching allergy_id+medication override exists", () => {
    const overrides: ResolvedAllergyOverride[] = [
      {
        allergy_id: PENICILLIN_ALLERGY_ID,
        allergen: "Penicillin",
        medication: "Amoxicillin 500mg",
        override_reason: "patient_tolerated_previously",
        overridden_at: new Date().toISOString(),
      },
    ];
    const flags = checkAllergyMedication(makeContext(overrides));
    expect(flags).toHaveLength(0);
  });

  it("suppresses all meds for the allergen when override has allergy_id but no medication", () => {
    // Override records the allergy-level clearance but no specific drug —
    // the rule layer treats this as "patient is cleared for this allergen
    // across any cross-reactive drug".
    const overrides: ResolvedAllergyOverride[] = [
      {
        allergy_id: PENICILLIN_ALLERGY_ID,
        allergen: "Penicillin",
        medication: null,
        override_reason: "misdiagnosed_allergy",
        overridden_at: new Date().toISOString(),
      },
    ];
    const flags = checkAllergyMedication(makeContext(overrides));
    expect(flags).toHaveLength(0);
  });

  it("does NOT suppress when override references a DIFFERENT allergy_id", () => {
    // An override for the sulfa allergy must not clear penicillin flags —
    // each allergy-drug pair is a separate clinical decision.
    const overrides: ResolvedAllergyOverride[] = [
      {
        allergy_id: SULFA_ALLERGY_ID,
        allergen: "Sulfa",
        medication: null,
        override_reason: "mild_reaction_ok",
        overridden_at: new Date().toISOString(),
      },
    ];
    const flags = checkAllergyMedication(makeContext(overrides));
    expect(flags.length).toBeGreaterThan(0);
  });

  it("suppresses via allergen-name fallback when allergy has no id", () => {
    const ctx = makeContext([
      {
        allergy_id: null,
        allergen: "Penicillin",
        medication: null,
        override_reason: "desensitized",
        overridden_at: new Date().toISOString(),
      },
    ]);
    // Strip the id to exercise the fallback path.
    ctx.allergies = ctx.allergies!.map((a) => ({ ...a, id: null }));
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });

  it("suppresses cross-reactivity flags (penicillin allergy + cephalosporin drug) when override covers the allergen", () => {
    const ctx: PatientContext = {
      active_diagnoses: [],
      active_diagnosis_codes: [],
      active_medications: ["Cefazolin 1g"],
      new_symptoms: [],
      care_team_specialties: [],
      allergies: [
        {
          id: PENICILLIN_ALLERGY_ID,
          allergen: "Penicillin",
          severity: "severe",
          reaction: "anaphylaxis",
        },
      ],
      resolved_overrides: [
        {
          allergy_id: PENICILLIN_ALLERGY_ID,
          allergen: "Penicillin",
          medication: null,
          override_reason: "benefit_exceeds_risk",
          overridden_at: new Date().toISOString(),
        },
      ],
    };
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });
});
