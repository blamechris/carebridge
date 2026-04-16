import { describe, it, expect } from "vitest";
import {
  toFhirAllergyIntolerance,
  hasAnaphylacticFeatures,
  mapReactionToCriticality,
  classifyAllergenCategory,
} from "../generators/allergy-intolerance.js";

type Allergy = Parameters<typeof toFhirAllergyIntolerance>[0];

function makeAllergy(
  overrides: Partial<Record<keyof Allergy, unknown>> = {},
): Allergy {
  return {
    id: "a1",
    allergen: "Penicillin",
    snomed_code: null,
    rxnorm_code: null,
    reaction: null,
    severity: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Allergy;
}

describe("toFhirAllergyIntolerance severity -> criticality mapping", () => {
  it("maps mild to low", () => {
    expect(
      toFhirAllergyIntolerance(makeAllergy({ severity: "mild" }), "p1")
        .criticality,
    ).toBe("low");
  });

  it("maps moderate to high (can escalate to anaphylaxis)", () => {
    expect(
      toFhirAllergyIntolerance(makeAllergy({ severity: "moderate" }), "p1")
        .criticality,
    ).toBe("high");
  });

  it("maps severe to high", () => {
    expect(
      toFhirAllergyIntolerance(makeAllergy({ severity: "severe" }), "p1")
        .criticality,
    ).toBe("high");
  });

  it("maps null/unknown to unable-to-assess", () => {
    expect(toFhirAllergyIntolerance(makeAllergy(), "p1").criticality).toBe(
      "unable-to-assess",
    );
    expect(
      toFhirAllergyIntolerance(makeAllergy({ severity: "bogus" }), "p1")
        .criticality,
    ).toBe("unable-to-assess");
  });
});

describe("hasAnaphylacticFeatures — #265 red-flag detection", () => {
  it.each([
    "Anaphylaxis with hypotension",
    "anaphylactic shock",
    "tongue swelling and airway compromise",
    "Lip swelling, difficulty breathing",
    "laryngeal swelling",
    "angioedema",
    "wheezing and shortness of breath",
    "syncope after exposure",
    "loss of consciousness",
    "stridor, throat closing",
  ])("detects %j as anaphylactic", (text) => {
    expect(hasAnaphylacticFeatures(text)).toBe(true);
  });

  it.each([
    "mild itching",
    "small rash on forearm",
    "GI upset",
    "nausea",
    "headache",
    null,
    "",
  ])("does not detect %j", (text) => {
    expect(hasAnaphylacticFeatures(text)).toBe(false);
  });
});

describe("mapReactionToCriticality — #265 refined rules", () => {
  it("elevates mild to high when anaphylactic language present", () => {
    expect(
      mapReactionToCriticality("mild", "tongue swelling, wheezing", "medication"),
    ).toBe("high");
  });

  it("elevates even null-severity to high on red flags (defensive floor)", () => {
    expect(
      mapReactionToCriticality(null, "anaphylaxis", "medication"),
    ).toBe("high");
  });

  it("keeps mild with benign reaction text as low", () => {
    expect(
      mapReactionToCriticality("mild", "small hives on wrist", "medication"),
    ).toBe("low");
  });

  it("returns unable-to-assess when severity is unknown and no red flags", () => {
    expect(mapReactionToCriticality(null, null, null)).toBe("unable-to-assess");
    expect(mapReactionToCriticality(null, "itching", null)).toBe(
      "unable-to-assess",
    );
  });

  it("maps severe to high regardless of category", () => {
    expect(mapReactionToCriticality("severe", null, "food")).toBe("high");
    expect(mapReactionToCriticality("severe", null, null)).toBe("high");
  });
});

describe("classifyAllergenCategory — #265 allergen class", () => {
  it("returns medication when an RxNorm code is present", () => {
    expect(classifyAllergenCategory("7980", null, "Penicillin")).toBe(
      "medication",
    );
  });

  it("returns food from known food SNOMED", () => {
    expect(classifyAllergenCategory(null, "91935009", "Peanut")).toBe("food");
  });

  it("returns food from allergen text pattern", () => {
    expect(classifyAllergenCategory(null, null, "Shellfish")).toBe("food");
    expect(classifyAllergenCategory(null, null, "tree nut")).toBe("food");
  });

  it("returns environment for latex/pollen/dust", () => {
    expect(classifyAllergenCategory(null, null, "Latex")).toBe("environment");
    expect(classifyAllergenCategory(null, null, "Dust mite")).toBe(
      "environment",
    );
    expect(classifyAllergenCategory(null, null, "Pollen")).toBe("environment");
  });

  it("returns medication for common drug names without codes", () => {
    expect(classifyAllergenCategory(null, null, "Penicillin")).toBe(
      "medication",
    );
    expect(classifyAllergenCategory(null, null, "Iodine contrast")).toBe(
      "medication",
    );
  });

  it("returns null when ambiguous (no coding, no keywords)", () => {
    expect(classifyAllergenCategory(null, null, "Mysterious agent")).toBeNull();
  });
});

describe("toFhirAllergyIntolerance — category output", () => {
  it("emits category=[medication] for RxNorm-coded allergens", () => {
    const fhir = toFhirAllergyIntolerance(
      makeAllergy({ rxnorm_code: "7980", allergen: "Penicillin" }),
      "p1",
    );
    expect(fhir.category).toEqual(["medication"]);
  });

  it("emits category=[food] for known food SNOMED", () => {
    const fhir = toFhirAllergyIntolerance(
      makeAllergy({ snomed_code: "91935009", allergen: "Peanut" }),
      "p1",
    );
    expect(fhir.category).toEqual(["food"]);
  });

  it("omits category when ambiguous", () => {
    const fhir = toFhirAllergyIntolerance(
      makeAllergy({ allergen: "Mysterious agent" }),
      "p1",
    );
    expect(fhir.category).toBeUndefined();
  });
});

describe("toFhirAllergyIntolerance — integration of red-flag detection", () => {
  it("bumps mild-with-anaphylaxis to criticality=high in the emitted resource", () => {
    const fhir = toFhirAllergyIntolerance(
      makeAllergy({
        severity: "mild",
        reaction: "tongue swelling and wheezing after first dose",
        rxnorm_code: "7980",
        allergen: "Penicillin",
      }),
      "p1",
    );
    expect(fhir.criticality).toBe("high");
    expect(fhir.category).toEqual(["medication"]);
    expect(fhir.reaction?.[0]?.severity).toBe("mild");
  });
});
