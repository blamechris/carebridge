/**
 * Inbound FHIR AllergyIntolerance → internal `allergies` row mapper
 * tests (#337).
 */
import { describe, it, expect } from "vitest";
import {
  mapFhirAllergyIntoleranceToRow,
  extractAllergen,
  extractRxNormCode,
  extractSnomedCode,
  mapCriticalityToSeverity,
  mapReactionSeverityToInternal,
  extractReactionDescription,
  extractOnsetDateTime,
  resolveRecorderReference,
  mapVerificationStatusToInternal,
  type InboundAllergyIntolerance,
} from "../allergy-mapper.js";

const PATIENT_ID = "patient-337";

describe("mapFhirAllergyIntoleranceToRow (#337)", () => {
  it("maps a drug allergy with RxNorm coding, criticality high, and reaction text", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      id: "ai-1",
      clinicalStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
            code: "active",
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
            code: "confirmed",
          },
        ],
      },
      code: {
        coding: [
          {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "7980",
            display: "Penicillin G",
          },
        ],
        text: "Penicillin",
      },
      patient: { reference: `Patient/${PATIENT_ID}` },
      recordedDate: "2026-04-10T00:00:00.000Z",
      criticality: "high",
      recorder: { reference: "Practitioner/prov-99" },
      reaction: [
        {
          manifestation: [
            {
              coding: [{ display: "Hives" }],
              text: "Hives",
            },
          ],
          description: "Patient developed hives and throat swelling",
          severity: "severe",
        },
      ],
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      patient_id: PATIENT_ID,
      allergen: "Penicillin",
      rxnorm_code: "7980",
      snomed_code: null,
      reaction: "Patient developed hives and throat swelling",
      severity: "severe",
      verification_status: "confirmed",
      onset_at: "2026-04-10T00:00:00.000Z",
      recorded_by: "prov-99",
      source_system: "fhir_import",
    });
  });

  it("maps a food allergen with text coding (no RxNorm, no SNOMED) and unable-to-assess criticality", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: {
        text: "Peanut",
      },
      patient: { reference: `Patient/${PATIENT_ID}` },
      criticality: "unable-to-assess",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.allergen).toBe("Peanut");
    expect(row!.rxnorm_code).toBeNull();
    expect(row!.snomed_code).toBeNull();
    // unable-to-assess → null severity (no internal analogue)
    expect(row!.severity).toBeNull();
    expect(row!.reaction).toBeNull();
  });

  it("maps an environmental allergen with SNOMED coding and criticality low", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "256259004",
            display: "Pollen",
          },
        ],
      },
      patient: { reference: `Patient/${PATIENT_ID}` },
      criticality: "low",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.allergen).toBe("Pollen");
    expect(row!.snomed_code).toBe("256259004");
    expect(row!.rxnorm_code).toBeNull();
    expect(row!.severity).toBe("mild");
  });

  it("returns null on verificationStatus: entered-in-error (chart correction)", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
            code: "entered-in-error",
          },
        ],
      },
      code: { text: "Aspirin" },
      patient: { reference: `Patient/${PATIENT_ID}` },
    };
    expect(mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID)).toBeNull();
  });

  it("returns null when code is missing (unmappable)", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      patient: { reference: `Patient/${PATIENT_ID}` },
    };
    expect(mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID)).toBeNull();
  });

  it("returns null when code has neither text nor display", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { coding: [{ system: "http://snomed.info/sct", code: "12345" }] },
      patient: { reference: `Patient/${PATIENT_ID}` },
    };
    // No display, no text → unmappable name.
    expect(mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID)).toBeNull();
  });

  it("fails open on missing reaction[] — row still materialises with reaction:null", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Latex" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      criticality: "high",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.allergen).toBe("Latex");
    expect(row!.reaction).toBeNull();
    expect(row!.severity).toBe("severe");
  });

  it("prefers reaction[0].description over manifestation.coding.display", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Sulfa" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      reaction: [
        {
          manifestation: [{ coding: [{ display: "Rash" }], text: "Rash" }],
          description: "Generalised maculopapular rash on day 5",
        },
      ],
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.reaction).toBe("Generalised maculopapular rash on day 5");
  });

  it("falls back to manifestation[0].text when reaction.description is missing", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Iodine" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      reaction: [
        {
          manifestation: [{ coding: [{ display: "Hives" }], text: "Hives" }],
        },
      ],
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.reaction).toBe("Hives");
  });

  it("prefers reaction.severity over criticality when both present", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Bee sting" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      criticality: "low",
      reaction: [
        {
          manifestation: [{ coding: [{ display: "Anaphylaxis" }], text: "Anaphylaxis" }],
          severity: "severe",
        },
      ],
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.severity).toBe("severe");
  });

  it("uses criticality when no reaction.severity is supplied", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Cat dander" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      criticality: "high",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.severity).toBe("severe");
  });

  it("falls back to onsetDateTime when recordedDate is absent", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Shellfish" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      onsetDateTime: "2020-06-15T00:00:00.000Z",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.onset_at).toBe("2020-06-15T00:00:00.000Z");
  });

  it("uses recordedDate as onset_at when onsetDateTime is absent", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Shellfish" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      recordedDate: "2024-01-01T00:00:00.000Z",
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.onset_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("falls back to asserter when recorder is missing", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Egg" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      asserter: { reference: "Practitioner/prov-77" },
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.recorded_by).toBe("prov-77");
  });

  it("returns recorded_by:null when reference is non-Practitioner", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Egg" },
      patient: { reference: `Patient/${PATIENT_ID}` },
      asserter: { reference: "Patient/patient-self-report" },
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.recorded_by).toBeNull();
  });

  it("defaults verification_status to 'unconfirmed' when not specified", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      code: { text: "Latex" },
      patient: { reference: `Patient/${PATIENT_ID}` },
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.verification_status).toBe("unconfirmed");
  });

  it("maps verification 'refuted' to internal 'refuted'", () => {
    const ai: InboundAllergyIntolerance = {
      resourceType: "AllergyIntolerance",
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
            code: "refuted",
          },
        ],
      },
      code: { text: "Sulfa" },
      patient: { reference: `Patient/${PATIENT_ID}` },
    };
    const row = mapFhirAllergyIntoleranceToRow(ai, PATIENT_ID);
    expect(row!.verification_status).toBe("refuted");
  });
});

describe("extractAllergen (#337)", () => {
  it("prefers code.text", () => {
    expect(
      extractAllergen({
        text: "Peanut",
        coding: [{ display: "Arachis hypogaea allergenic extract" }],
      }),
    ).toBe("Peanut");
  });

  it("falls back to first non-empty coding.display", () => {
    expect(
      extractAllergen({
        coding: [
          { code: "1" }, // no display
          { display: "Penicillin" },
        ],
      }),
    ).toBe("Penicillin");
  });

  it("returns null when nothing usable is present", () => {
    expect(extractAllergen({})).toBeNull();
    expect(extractAllergen({ coding: [{ code: "x" }] })).toBeNull();
    expect(extractAllergen(undefined)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(extractAllergen({ text: "  Peanut  " })).toBe("Peanut");
  });
});

describe("extractRxNormCode (#337)", () => {
  it("returns the first RxNorm-coded entry", () => {
    expect(
      extractRxNormCode({
        coding: [
          { system: "http://snomed.info/sct", code: "12345" },
          {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "7980",
          },
        ],
      }),
    ).toBe("7980");
  });

  it("rejects the placeholder 'unknown' code", () => {
    expect(
      extractRxNormCode({
        coding: [
          {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "unknown",
          },
        ],
      }),
    ).toBeNull();
  });

  it("returns null when no RxNorm coding present", () => {
    expect(extractRxNormCode({ text: "Foo" })).toBeNull();
    expect(extractRxNormCode(undefined)).toBeNull();
  });
});

describe("extractSnomedCode (#337)", () => {
  it("returns the first SNOMED-coded entry", () => {
    expect(
      extractSnomedCode({
        coding: [
          {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "7980",
          },
          { system: "http://snomed.info/sct", code: "91935009" },
        ],
      }),
    ).toBe("91935009");
  });

  it("rejects the placeholder 'unknown' code", () => {
    expect(
      extractSnomedCode({
        coding: [{ system: "http://snomed.info/sct", code: "unknown" }],
      }),
    ).toBeNull();
  });

  it("returns null when no SNOMED coding present", () => {
    expect(extractSnomedCode({ text: "Foo" })).toBeNull();
    expect(extractSnomedCode(undefined)).toBeNull();
  });
});

describe("mapCriticalityToSeverity (#337)", () => {
  it("maps high → severe", () => {
    expect(mapCriticalityToSeverity("high")).toBe("severe");
  });

  it("maps low → mild", () => {
    expect(mapCriticalityToSeverity("low")).toBe("mild");
  });

  it("maps unable-to-assess → null", () => {
    expect(mapCriticalityToSeverity("unable-to-assess")).toBeNull();
  });

  it("maps undefined / unknown criticality → null", () => {
    expect(mapCriticalityToSeverity(undefined)).toBeNull();
    expect(mapCriticalityToSeverity("bogus")).toBeNull();
  });
});

describe("mapReactionSeverityToInternal (#337)", () => {
  it("maps FHIR reaction severity tokens directly", () => {
    expect(mapReactionSeverityToInternal("mild")).toBe("mild");
    expect(mapReactionSeverityToInternal("moderate")).toBe("moderate");
    expect(mapReactionSeverityToInternal("severe")).toBe("severe");
  });

  it("returns null for unknown / missing values", () => {
    expect(mapReactionSeverityToInternal(undefined)).toBeNull();
    expect(mapReactionSeverityToInternal("critical")).toBeNull();
  });
});

describe("extractReactionDescription (#337)", () => {
  it("prefers reaction.description", () => {
    expect(
      extractReactionDescription({
        manifestation: [{ coding: [{ display: "Rash" }] }],
        description: "Generalised maculopapular rash",
      }),
    ).toBe("Generalised maculopapular rash");
  });

  it("falls back to manifestation[0].text", () => {
    expect(
      extractReactionDescription({
        manifestation: [{ coding: [{ display: "Hives" }], text: "Hives" }],
      }),
    ).toBe("Hives");
  });

  it("falls back to manifestation[0].coding[0].display", () => {
    expect(
      extractReactionDescription({
        manifestation: [{ coding: [{ display: "Wheezing" }] }],
      }),
    ).toBe("Wheezing");
  });

  it("returns null when no usable description present", () => {
    expect(extractReactionDescription(undefined)).toBeNull();
    expect(extractReactionDescription({ manifestation: [] })).toBeNull();
    expect(extractReactionDescription({ manifestation: [{}] })).toBeNull();
  });
});

describe("extractOnsetDateTime (#337)", () => {
  it("returns onsetDateTime when present", () => {
    expect(extractOnsetDateTime({ onsetDateTime: "2020-01-01T00:00:00.000Z" })).toBe(
      "2020-01-01T00:00:00.000Z",
    );
  });

  it("falls back to onsetPeriod.start", () => {
    expect(
      extractOnsetDateTime({
        onsetPeriod: { start: "2019-06-01T00:00:00.000Z" },
      }),
    ).toBe("2019-06-01T00:00:00.000Z");
  });

  it("returns null when no onset variant is present", () => {
    expect(extractOnsetDateTime({})).toBeNull();
  });
});

describe("resolveRecorderReference (#337)", () => {
  it("parses Practitioner/{id}", () => {
    expect(resolveRecorderReference({ reference: "Practitioner/abc" })).toBe(
      "abc",
    );
  });

  it("returns null on non-Practitioner reference", () => {
    expect(resolveRecorderReference({ reference: "Patient/abc" })).toBeNull();
    expect(resolveRecorderReference(undefined)).toBeNull();
  });
});

describe("mapVerificationStatusToInternal (#337)", () => {
  it("maps confirmed → confirmed", () => {
    expect(mapVerificationStatusToInternal("confirmed")).toBe("confirmed");
  });

  it("maps unconfirmed → unconfirmed", () => {
    expect(mapVerificationStatusToInternal("unconfirmed")).toBe("unconfirmed");
  });

  it("maps refuted → refuted", () => {
    expect(mapVerificationStatusToInternal("refuted")).toBe("refuted");
  });

  it("maps entered-in-error → null (signals 'skip this entry')", () => {
    expect(mapVerificationStatusToInternal("entered-in-error")).toBeNull();
  });

  it("defaults to unconfirmed for unknown / missing values", () => {
    expect(mapVerificationStatusToInternal(undefined)).toBe("unconfirmed");
    expect(mapVerificationStatusToInternal("bogus")).toBe("unconfirmed");
  });
});
