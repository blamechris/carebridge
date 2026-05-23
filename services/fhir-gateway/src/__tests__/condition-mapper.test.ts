/**
 * Inbound FHIR Condition → internal `diagnoses` row mapper tests (#337).
 *
 * Mirrors the medication-mapper test layout (see medication-mapper.test.ts)
 * so the two inbound mappers stay structurally consistent.
 */
import { describe, it, expect } from "vitest";
import {
  mapFhirConditionToRow,
  extractConditionName,
  extractIcd10Code,
  extractSnomedCode,
  mapClinicalStatusToInternal,
  extractOnsetDateTime,
  extractRecordedDate,
  resolveRecorderReference,
  extractSeverity,
  isEnteredInError,
  type InboundCondition,
} from "../condition-mapper.js";

const PATIENT_ID = "patient-337";

describe("mapFhirConditionToRow (#337)", () => {
  it("maps a fully-populated Condition to a row with every field set", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      id: "cond-1",
      clinicalStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/condition-clinical",
            code: "active",
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            code: "confirmed",
          },
        ],
      },
      code: {
        coding: [
          {
            system: "http://hl7.org/fhir/sid/icd-10-cm",
            code: "C50.911",
            display: "Malignant neoplasm of breast",
          },
          {
            system: "http://snomed.info/sct",
            code: "254837009",
            display: "Malignant neoplasm of breast",
          },
        ],
        text: "Malignant neoplasm of breast",
      },
      subject: { reference: `Patient/${PATIENT_ID}` },
      onsetDateTime: "2026-04-10T00:00:00.000Z",
      recordedDate: "2026-04-11T00:00:00.000Z",
      recorder: { reference: "Practitioner/prov-99" },
      severity: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "24484000",
            display: "Severe",
          },
        ],
      },
    };
    const row = mapFhirConditionToRow(cond, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      patient_id: PATIENT_ID,
      description: "Malignant neoplasm of breast",
      icd10_code: "C50.911",
      snomed_code: "254837009",
      status: "active",
      onset_date: "2026-04-10T00:00:00.000Z",
      resolved_date: null,
      diagnosed_by: "prov-99",
      severity: "severe",
      recorded_at: "2026-04-11T00:00:00.000Z",
    });
  });

  it("returns null when code is missing entirely", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
    };
    expect(mapFhirConditionToRow(cond, PATIENT_ID)).toBeNull();
  });

  it("returns null when code has no text and no coding entries", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: { coding: [] },
    };
    expect(mapFhirConditionToRow(cond, PATIENT_ID)).toBeNull();
  });

  it("returns null when verificationStatus is entered-in-error (chart correction)", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      verificationStatus: {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/condition-ver-status",
            code: "entered-in-error",
          },
        ],
      },
      code: { text: "Hypertension" },
    };
    expect(mapFhirConditionToRow(cond, PATIENT_ID)).toBeNull();
  });

  it("preserves SNOMED-only coding (no ICD-10) and sets icd10_code to null", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "73211009",
            display: "Diabetes mellitus",
          },
        ],
      },
    };
    const row = mapFhirConditionToRow(cond, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.icd10_code).toBeNull();
    expect(row!.snomed_code).toBe("73211009");
    expect(row!.description).toBe("Diabetes mellitus");
  });

  it("fails open on missing onsetDateTime — row materialises with null onset_date", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: { text: "Hypertension" },
    };
    const row = mapFhirConditionToRow(cond, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.onset_date).toBeNull();
    expect(row!.description).toBe("Hypertension");
  });

  it("falls back to onsetPeriod.start when onsetDateTime is absent", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: { text: "Asthma" },
      onsetPeriod: { start: "2024-01-01T00:00:00.000Z" },
    };
    expect(mapFhirConditionToRow(cond, PATIENT_ID)?.onset_date).toBe(
      "2024-01-01T00:00:00.000Z",
    );
  });

  it("uses code.text when present, falling back to coding.display", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: {
        coding: [{ display: "From-coding" }],
        text: "From-text",
      },
    };
    expect(mapFhirConditionToRow(cond, PATIENT_ID)?.description).toBe(
      "From-text",
    );
  });

  it("treats ICD-10 'icd-10' system shorthand the same as the canonical URL", () => {
    const cond: InboundCondition = {
      resourceType: "Condition",
      code: {
        coding: [
          {
            system: "icd-10",
            code: "I10",
            display: "Essential hypertension",
          },
        ],
      },
    };
    const row = mapFhirConditionToRow(cond, PATIENT_ID);
    expect(row?.icd10_code).toBe("I10");
  });
});

describe("clinicalStatus mapping (#337)", () => {
  it("maps active / chronic via the FHIR coded value set", () => {
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "active" }],
      }),
    ).toBe("active");
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "recurrence" }],
      }),
    ).toBe("active");
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "remission" }],
      }),
    ).toBe("chronic");
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "relapse" }],
      }),
    ).toBe("active");
  });

  it("maps resolved / inactive to resolved", () => {
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "resolved" }],
      }),
    ).toBe("resolved");
    expect(
      mapClinicalStatusToInternal({
        coding: [{ code: "inactive" }],
      }),
    ).toBe("resolved");
  });

  it("defaults to active when missing or unknown", () => {
    expect(mapClinicalStatusToInternal(undefined)).toBe("active");
    expect(mapClinicalStatusToInternal({ coding: [] })).toBe("active");
    expect(
      mapClinicalStatusToInternal({ coding: [{ code: "not-a-status" }] }),
    ).toBe("active");
  });
});

describe("isEnteredInError (#337)", () => {
  it("returns true only for entered-in-error verificationStatus", () => {
    expect(
      isEnteredInError({
        coding: [{ code: "entered-in-error" }],
      }),
    ).toBe(true);
    expect(
      isEnteredInError({
        coding: [{ code: "confirmed" }],
      }),
    ).toBe(false);
    expect(isEnteredInError(undefined)).toBe(false);
  });
});

describe("code extraction helpers (#337)", () => {
  it("extractConditionName prefers text, then coding.display", () => {
    expect(extractConditionName({ text: "Hypertension" })).toBe(
      "Hypertension",
    );
    expect(
      extractConditionName({
        coding: [{ display: "Diabetes" }],
      }),
    ).toBe("Diabetes");
    expect(extractConditionName({ coding: [] })).toBeNull();
    expect(extractConditionName(undefined)).toBeNull();
  });

  it("extractIcd10Code returns first ICD-10 coded entry", () => {
    expect(
      extractIcd10Code({
        coding: [
          { system: "http://snomed.info/sct", code: "73211009" },
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" },
        ],
      }),
    ).toBe("E11.9");
  });

  it("extractIcd10Code rejects the export-side 'unknown' placeholder", () => {
    expect(
      extractIcd10Code({
        coding: [
          {
            system: "http://hl7.org/fhir/sid/icd-10-cm",
            code: "unknown",
          },
        ],
      }),
    ).toBeNull();
  });

  it("extractSnomedCode returns first SNOMED-coded entry", () => {
    expect(
      extractSnomedCode({
        coding: [
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10" },
          { system: "http://snomed.info/sct", code: "59621000" },
        ],
      }),
    ).toBe("59621000");
  });
});

describe("date and reference helpers (#337)", () => {
  it("extractOnsetDateTime prefers onsetDateTime over onsetPeriod.start", () => {
    expect(
      extractOnsetDateTime({
        resourceType: "Condition",
        onsetDateTime: "2026-01-01T00:00:00.000Z",
        onsetPeriod: { start: "2020-01-01T00:00:00.000Z" },
      }),
    ).toBe("2026-01-01T00:00:00.000Z");
  });

  it("extractOnsetDateTime falls back to onsetPeriod.start", () => {
    expect(
      extractOnsetDateTime({
        resourceType: "Condition",
        onsetPeriod: { start: "2020-01-01T00:00:00.000Z" },
      }),
    ).toBe("2020-01-01T00:00:00.000Z");
  });

  it("extractOnsetDateTime returns null when neither is set", () => {
    expect(
      extractOnsetDateTime({ resourceType: "Condition" }),
    ).toBeNull();
  });

  it("extractRecordedDate returns recordedDate as-is", () => {
    expect(
      extractRecordedDate({
        resourceType: "Condition",
        recordedDate: "2026-04-11T00:00:00.000Z",
      }),
    ).toBe("2026-04-11T00:00:00.000Z");
    expect(
      extractRecordedDate({ resourceType: "Condition" }),
    ).toBeNull();
  });

  it("resolveRecorderReference parses Practitioner/{id}", () => {
    expect(
      resolveRecorderReference({ reference: "Practitioner/abc-123" }),
    ).toBe("abc-123");
    expect(
      resolveRecorderReference({ reference: "Patient/abc-123" }),
    ).toBeNull();
    expect(resolveRecorderReference(undefined)).toBeNull();
  });
});

describe("extractSeverity (#337)", () => {
  it("maps SNOMED severity codes to the internal mild/moderate/severe enum", () => {
    expect(
      extractSeverity({
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "255604002",
            display: "Mild",
          },
        ],
      }),
    ).toBe("mild");
    expect(
      extractSeverity({
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "6736007",
            display: "Moderate",
          },
        ],
      }),
    ).toBe("moderate");
    expect(
      extractSeverity({
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "24484000",
            display: "Severe",
          },
        ],
      }),
    ).toBe("severe");
  });

  it("falls back to display / text token matching", () => {
    expect(extractSeverity({ text: "mild" })).toBe("mild");
    expect(extractSeverity({ text: "MODERATE" })).toBe("moderate");
    expect(
      extractSeverity({ coding: [{ display: "Severe" }] }),
    ).toBe("severe");
  });

  it("returns null on unknown or missing severity", () => {
    expect(extractSeverity({ text: "fluctuating" })).toBeNull();
    expect(extractSeverity({ coding: [] })).toBeNull();
    expect(extractSeverity(undefined)).toBeNull();
  });
});
