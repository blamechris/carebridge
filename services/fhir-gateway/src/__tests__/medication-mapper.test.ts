/**
 * Inbound FHIR MedicationRequest / MedicationStatement → internal
 * `medications` row mapper tests (#1066).
 */
import { describe, it, expect } from "vitest";
import {
  mapMedicationRequestToRow,
  mapMedicationStatementToRow,
  mapRoute,
  mapRequestStatusToInternal,
  mapStatementStatusToInternal,
  extractMaxDosesPerDay,
  extractDoseQuantity,
  extractFrequency,
  extractMedicationName,
  extractRxNormCode,
  resolvePractitionerReference,
  type InboundMedicationRequest,
  type InboundMedicationStatement,
} from "../medication-mapper.js";

const PATIENT_ID = "patient-1066";

describe("mapMedicationRequestToRow (#1066)", () => {
  it("maps a fully-populated MedicationRequest to a row with every field set", () => {
    const req: InboundMedicationRequest = {
      resourceType: "MedicationRequest",
      id: "mr-1",
      status: "active",
      intent: "order",
      medicationCodeableConcept: {
        coding: [
          {
            system: "http://www.nlm.nih.gov/research/umls/rxnorm",
            code: "723",
            display: "Amoxicillin",
          },
        ],
        text: "Amoxicillin",
      },
      subject: { reference: `Patient/${PATIENT_ID}` },
      authoredOn: "2026-04-10T00:00:00.000Z",
      requester: { reference: "Practitioner/prov-99" },
      dosageInstruction: [
        {
          timing: { code: { text: "TID" } },
          route: {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: "26643006",
                display: "Oral route",
              },
            ],
            text: "oral",
          },
          doseAndRate: [
            { doseQuantity: { value: 500, unit: "mg", system: "http://unitsofmeasure.org", code: "mg" } },
          ],
        },
      ],
    };
    const row = mapMedicationRequestToRow(req, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      patient_id: PATIENT_ID,
      name: "Amoxicillin",
      dose_amount: 500,
      dose_unit: "mg",
      route: "oral",
      frequency: "TID",
      max_doses_per_day: null,
      status: "active",
      started_at: "2026-04-10T00:00:00.000Z",
      prescribed_by: "prov-99",
      rxnorm_code: "723",
      source_system: "fhir_import",
    });
  });

  it("returns null when the medication name is missing", () => {
    const req: InboundMedicationRequest = {
      resourceType: "MedicationRequest",
      status: "active",
    };
    expect(mapMedicationRequestToRow(req, PATIENT_ID)).toBeNull();
  });

  it("returns null when status is entered-in-error (chart correction)", () => {
    const req: InboundMedicationRequest = {
      resourceType: "MedicationRequest",
      status: "entered-in-error",
      medicationCodeableConcept: { text: "Aspirin" },
    };
    expect(mapMedicationRequestToRow(req, PATIENT_ID)).toBeNull();
  });

  it("preserves dose detail when dosageInstruction has only doseQuantity", () => {
    const req: InboundMedicationRequest = {
      resourceType: "MedicationRequest",
      status: "active",
      medicationCodeableConcept: { text: "Morphine" },
      dosageInstruction: [
        {
          doseAndRate: [{ doseQuantity: { value: 10, unit: "mg" } }],
        },
      ],
    };
    const row = mapMedicationRequestToRow(req, PATIENT_ID);
    expect(row?.dose_amount).toBe(10);
    expect(row?.dose_unit).toBe("mg");
    expect(row?.frequency).toBeNull();
    expect(row?.route).toBeNull();
  });

  it("falls back to coding.display when medicationCodeableConcept.text is missing", () => {
    const req: InboundMedicationRequest = {
      resourceType: "MedicationRequest",
      status: "active",
      medicationCodeableConcept: {
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "1191", display: "Aspirin" }],
      },
    };
    expect(mapMedicationRequestToRow(req, PATIENT_ID)?.name).toBe("Aspirin");
  });
});

describe("mapMedicationStatementToRow (#1066)", () => {
  it("maps a MedicationStatement with no requester to a row with null prescribed_by", () => {
    const stmt: InboundMedicationStatement = {
      resourceType: "MedicationStatement",
      id: "ms-1",
      status: "active",
      medicationCodeableConcept: { text: "Lisinopril" },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectivePeriod: { start: "2025-12-01T00:00:00.000Z" },
      dosage: [
        {
          timing: { code: { text: "daily" } },
          route: { text: "oral" },
          doseAndRate: [{ doseQuantity: { value: 10, unit: "mg" } }],
        },
      ],
    };
    const row = mapMedicationStatementToRow(stmt, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Lisinopril");
    expect(row!.prescribed_by).toBeNull();
    expect(row!.started_at).toBe("2025-12-01T00:00:00.000Z");
    expect(row!.status).toBe("active");
    expect(row!.dose_amount).toBe(10);
    expect(row!.route).toBe("oral");
  });

  it("falls back to dateAsserted when effectivePeriod.start is absent", () => {
    const stmt: InboundMedicationStatement = {
      resourceType: "MedicationStatement",
      status: "active",
      medicationCodeableConcept: { text: "Vitamin D" },
      dateAsserted: "2025-11-01T00:00:00.000Z",
    };
    const row = mapMedicationStatementToRow(stmt, PATIENT_ID);
    expect(row?.started_at).toBe("2025-11-01T00:00:00.000Z");
  });

  it("returns null on entered-in-error statement", () => {
    const stmt: InboundMedicationStatement = {
      resourceType: "MedicationStatement",
      status: "entered-in-error",
      medicationCodeableConcept: { text: "Acetaminophen" },
    };
    expect(mapMedicationStatementToRow(stmt, PATIENT_ID)).toBeNull();
  });
});

describe("extractMaxDosesPerDay — per-day Ratio handling (#1066)", () => {
  it("extracts the numerator value when denominator is per-day (UCUM 'd')", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: {
          numerator: { value: 4, unit: "doses" },
          denominator: { value: 1, unit: "day", system: "http://unitsofmeasure.org", code: "d" },
        },
      }),
    ).toBe(4);
  });

  it("accepts denominator unit='day' without UCUM code", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: {
          numerator: { value: 6 },
          denominator: { value: 1, unit: "day" },
        },
      }),
    ).toBe(6);
  });

  it("accepts the entry when denominator is absent (per-day implicit)", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: {
          numerator: { value: 3 },
        },
      }),
    ).toBe(3);
  });

  it("rejects per-week denominator (returns null — fail-open)", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: {
          numerator: { value: 14 },
          denominator: { value: 1, unit: "week", code: "wk" },
        },
      }),
    ).toBeNull();
  });

  it("rejects denominator value other than 1 (e.g. per-2-days)", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: {
          numerator: { value: 4 },
          denominator: { value: 2, code: "d" },
        },
      }),
    ).toBeNull();
  });

  it("returns null when numerator is missing", () => {
    expect(extractMaxDosesPerDay({ maxDosePerPeriod: {} })).toBeNull();
  });

  it("returns null when maxDosePerPeriod is absent", () => {
    expect(extractMaxDosesPerDay({})).toBeNull();
    expect(extractMaxDosesPerDay(undefined)).toBeNull();
  });

  it("floors fractional numerators", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: { numerator: { value: 4.7, unit: "doses" } },
      }),
    ).toBe(4);
  });

  it("rejects zero / negative numerator (no-cap signal)", () => {
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: { numerator: { value: 0 } },
      }),
    ).toBeNull();
    expect(
      extractMaxDosesPerDay({
        maxDosePerPeriod: { numerator: { value: -1 } },
      }),
    ).toBeNull();
  });
});

describe("mapRoute (#1066)", () => {
  const cases: Array<[string, string]> = [
    ["26643006", "oral"],
    ["47625008", "IV"],
    ["78421000", "IM"],
    ["34206005", "subcutaneous"],
    ["6064005", "topical"],
    ["418730005", "inhaled"],
    ["37161004", "rectal"],
  ];
  for (const [code, expected] of cases) {
    it(`maps SNOMED ${code} → ${expected}`, () => {
      expect(
        mapRoute({
          coding: [{ system: "http://snomed.info/sct", code }],
        }),
      ).toBe(expected);
    });
  }

  it("falls back to free-text 'oral'", () => {
    expect(mapRoute({ text: "oral" })).toBe("oral");
    expect(mapRoute({ text: "PO" })).toBe("oral");
  });

  it("handles common alias text 'subq' / 'SC'", () => {
    expect(mapRoute({ text: "subq" })).toBe("subcutaneous");
    expect(mapRoute({ text: "SC" })).toBe("subcutaneous");
  });

  it("returns null on unknown route", () => {
    expect(mapRoute({ text: "epidural" })).toBeNull();
    expect(mapRoute(undefined)).toBeNull();
  });
});

describe("status mapping (#1066)", () => {
  it("MedicationRequest status maps correctly", () => {
    expect(mapRequestStatusToInternal("active")).toBe("active");
    expect(mapRequestStatusToInternal("on-hold")).toBe("held");
    expect(mapRequestStatusToInternal("completed")).toBe("completed");
    expect(mapRequestStatusToInternal("cancelled")).toBe("discontinued");
    expect(mapRequestStatusToInternal("stopped")).toBe("discontinued");
    expect(mapRequestStatusToInternal("entered-in-error")).toBeNull();
    expect(mapRequestStatusToInternal("draft")).toBe("active");
    expect(mapRequestStatusToInternal(undefined)).toBe("active");
    expect(mapRequestStatusToInternal("ACTIVE")).toBe("active");
  });

  it("MedicationStatement status maps correctly", () => {
    expect(mapStatementStatusToInternal("active")).toBe("active");
    expect(mapStatementStatusToInternal("on-hold")).toBe("held");
    expect(mapStatementStatusToInternal("completed")).toBe("completed");
    expect(mapStatementStatusToInternal("stopped")).toBe("discontinued");
    expect(mapStatementStatusToInternal("not-taken")).toBe("discontinued");
    expect(mapStatementStatusToInternal("intended")).toBe("active");
    expect(mapStatementStatusToInternal("entered-in-error")).toBeNull();
    expect(mapStatementStatusToInternal(undefined)).toBe("active");
  });
});

describe("name and code extraction helpers (#1066)", () => {
  it("extractMedicationName prefers text, then coding.display", () => {
    expect(extractMedicationName({ text: "Aspirin" })).toBe("Aspirin");
    expect(
      extractMedicationName({ coding: [{ display: "Aspirin" }] }),
    ).toBe("Aspirin");
    expect(extractMedicationName({})).toBeNull();
    expect(extractMedicationName(undefined)).toBeNull();
  });

  it("extractRxNormCode returns first RxNorm-coded entry", () => {
    expect(
      extractRxNormCode({
        coding: [
          { system: "other", code: "X" },
          { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "723" },
        ],
      }),
    ).toBe("723");
  });

  it("extractRxNormCode rejects the placeholder 'unknown' code", () => {
    expect(
      extractRxNormCode({
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "unknown" }],
      }),
    ).toBeNull();
  });

  it("extractDoseQuantity returns null when value or unit missing", () => {
    expect(extractDoseQuantity({ doseAndRate: [{ doseQuantity: {} }] })).toBeNull();
    expect(
      extractDoseQuantity({ doseAndRate: [{ doseQuantity: { value: 10 } }] }),
    ).toBeNull();
  });

  it("extractDoseQuantity uses doseQuantity.code as unit fallback", () => {
    expect(
      extractDoseQuantity({
        doseAndRate: [{ doseQuantity: { value: 5, code: "mg" } }],
      }),
    ).toEqual({ amount: 5, unit: "mg" });
  });

  it("extractFrequency prefers timing.code.text", () => {
    expect(
      extractFrequency({ timing: { code: { text: "BID" } } }),
    ).toBe("BID");
  });

  it("resolvePractitionerReference parses Practitioner/{id}", () => {
    expect(
      resolvePractitionerReference({ reference: "Practitioner/abc-123" }),
    ).toBe("abc-123");
    expect(
      resolvePractitionerReference({ reference: "Patient/abc-123" }),
    ).toBeNull();
    expect(resolvePractitionerReference(undefined)).toBeNull();
  });
});
