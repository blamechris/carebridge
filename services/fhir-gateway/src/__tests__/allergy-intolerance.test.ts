import { describe, it, expect } from "vitest";
import { toFhirAllergyIntolerance } from "../generators/allergy-intolerance.js";

type Allergy = Parameters<typeof toFhirAllergyIntolerance>[0];

function makeAllergy(severity: string | null): Allergy {
  return {
    id: "a1",
    allergen: "Penicillin",
    snomed_code: null,
    rxnorm_code: null,
    reaction: null,
    severity,
    created_at: "2026-01-01T00:00:00.000Z",
  } as unknown as Allergy;
}

describe("toFhirAllergyIntolerance severity -> criticality mapping", () => {
  it("maps mild to low", () => {
    expect(toFhirAllergyIntolerance(makeAllergy("mild"), "p1").criticality).toBe(
      "low",
    );
  });

  it("maps moderate to high (can escalate to anaphylaxis)", () => {
    expect(
      toFhirAllergyIntolerance(makeAllergy("moderate"), "p1").criticality,
    ).toBe("high");
  });

  it("maps severe to high", () => {
    expect(
      toFhirAllergyIntolerance(makeAllergy("severe"), "p1").criticality,
    ).toBe("high");
  });

  it("maps null/unknown to unable-to-assess", () => {
    expect(toFhirAllergyIntolerance(makeAllergy(null), "p1").criticality).toBe(
      "unable-to-assess",
    );
    expect(
      toFhirAllergyIntolerance(makeAllergy("bogus"), "p1").criticality,
    ).toBe("unable-to-assess");
  });
});
