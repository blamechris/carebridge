/**
 * Inbound FHIR DiagnosticReport → internal lab_panels (+ child
 * lab_results) mapper tests (#337).
 */
import { describe, it, expect } from "vitest";
import {
  mapFhirDiagnosticReportToRow,
  extractPanelName,
  extractPanelLoinc,
  resolvePractitionerReference,
  normaliseObservationReference,
  mapLabObservationToResultRow,
  shouldImportDiagnosticReport,
  indexBundleObservations,
  type InboundDiagnosticReport,
  type InboundObservation,
} from "../diagnostic-report-mapper.js";

const PATIENT_ID = "patient-337";

describe("mapFhirDiagnosticReportToRow — panel core (#337)", () => {
  it("maps a fully-populated CBC DiagnosticReport to a panel row with every field set", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-cbc-1",
      status: "final",
      code: {
        coding: [
          { system: "http://loinc.org", code: "58410-2", display: "CBC panel - Blood by Automated count" },
        ],
        text: "CBC",
      },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectiveDateTime: "2026-05-22T08:00:00.000Z",
      issued: "2026-05-22T09:30:00.000Z",
      performer: [{ reference: "Practitioner/lab-tech-1" }],
      resultsInterpreter: [{ reference: "Practitioner/dr-smith" }],
      result: [],
    };

    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID);
    expect(mapped).not.toBeNull();
    expect(mapped!.panel).toEqual({
      patient_id: PATIENT_ID,
      panel_name: "CBC",
      panel_code: "58410-2",
      // resultsInterpreter (the ordering clinician) wins over performer.
      ordered_by: "dr-smith",
      ordering_provider_id: "dr-smith",
      collected_at: "2026-05-22T08:00:00.000Z",
      reported_at: "2026-05-22T09:30:00.000Z",
      source_system: "fhir_import",
    });
    // No observations supplied → results: [] (panel still emitted).
    expect(mapped!.results).toEqual([]);
  });

  it("returns null when the panel name is missing", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
    };
    expect(mapFhirDiagnosticReportToRow(report, PATIENT_ID)).toBeNull();
  });

  it("returns null when status is entered-in-error (chart correction)", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "entered-in-error",
      code: { text: "CBC" },
    };
    expect(mapFhirDiagnosticReportToRow(report, PATIENT_ID)).toBeNull();
  });

  it("falls back to coding.display when code.text is absent", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: "24323-8", display: "Comprehensive metabolic panel" }],
      },
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID);
    expect(mapped!.panel.panel_name).toBe("Comprehensive metabolic panel");
    expect(mapped!.panel.panel_code).toBe("24323-8");
  });

  it("falls back to effectivePeriod.start when effectiveDateTime is absent", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "BMP" },
      effectivePeriod: { start: "2026-04-12T10:00:00.000Z", end: "2026-04-12T10:05:00.000Z" },
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID);
    expect(mapped!.panel.collected_at).toBe("2026-04-12T10:00:00.000Z");
  });

  it("emits a panel with null ordering provider when no performer is present", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "Lipid panel" },
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID);
    expect(mapped!.panel.ordered_by).toBeNull();
    expect(mapped!.panel.ordering_provider_id).toBeNull();
  });

  it("emits a panel with no results when none of the result[] refs resolve", () => {
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "CBC" },
      result: [{ reference: "Observation/obs-missing" }],
    };
    const observations = new Map<string, InboundObservation>();
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID, observations);
    expect(mapped!.results).toEqual([]);
  });
});

describe("mapFhirDiagnosticReportToRow — child observation materialisation (#337)", () => {
  it("materialises a CBC panel's three referenced Observations into lab_results rows", () => {
    const wbcObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-wbc",
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: "6690-2", display: "WBC" }],
        text: "WBC",
      },
      valueQuantity: { value: 7.5, unit: "10*3/uL", system: "http://unitsofmeasure.org", code: "10*3/uL" },
      referenceRange: [
        { low: { value: 4.5, unit: "10*3/uL" }, high: { value: 11, unit: "10*3/uL" } },
      ],
    };
    const hgbObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-hgb",
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: "718-7", display: "Hemoglobin" }],
        text: "Hemoglobin",
      },
      valueQuantity: { value: 9.2, unit: "g/dL" },
      referenceRange: [
        { low: { value: 12, unit: "g/dL" }, high: { value: 16, unit: "g/dL" } },
      ],
      interpretation: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
              code: "L",
              display: "Low",
            },
          ],
        },
      ],
    };
    const pltObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-plt",
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: "777-3", display: "Platelet count" }],
        text: "Platelets",
      },
      valueQuantity: { value: 250, unit: "10*3/uL" },
    };

    const observations = new Map<string, InboundObservation>([
      ["obs-wbc", wbcObs],
      ["obs-hgb", hgbObs],
      ["obs-plt", pltObs],
    ]);

    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "dr-cbc-1",
      status: "final",
      code: { text: "CBC", coding: [{ system: "http://loinc.org", code: "58410-2" }] },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectiveDateTime: "2026-05-22T08:00:00.000Z",
      issued: "2026-05-22T09:30:00.000Z",
      result: [
        { reference: "Observation/obs-wbc" },
        { reference: "Observation/obs-hgb" },
        { reference: "Observation/obs-plt" },
      ],
    };

    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID, observations);
    expect(mapped).not.toBeNull();
    expect(mapped!.results).toHaveLength(3);

    const byName = Object.fromEntries(mapped!.results.map((r) => [r.test_name, r]));
    expect(byName.WBC).toEqual({
      test_name: "WBC",
      test_code: "6690-2",
      value: 7.5,
      unit: "10*3/uL",
      reference_low: 4.5,
      reference_high: 11,
      flag: null,
    });
    expect(byName.Hemoglobin).toEqual({
      test_name: "Hemoglobin",
      test_code: "718-7",
      value: 9.2,
      unit: "g/dL",
      reference_low: 12,
      reference_high: 16,
      flag: "L",
    });
    expect(byName.Platelets).toEqual({
      test_name: "Platelets",
      test_code: "777-3",
      value: 250,
      unit: "10*3/uL",
      reference_low: null,
      reference_high: null,
      flag: null,
    });
  });

  it("resolves urn:uuid: bundle-local references to indexed observations", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      code: { text: "Sodium" },
      valueQuantity: { value: 140, unit: "mEq/L" },
    };
    const observations = new Map<string, InboundObservation>([
      ["abc-uuid-1234", obs],
      ["obs-1", obs],
    ]);
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "BMP" },
      result: [{ reference: "urn:uuid:abc-uuid-1234" }],
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID, observations);
    expect(mapped!.results).toHaveLength(1);
    expect(mapped!.results[0]!.test_name).toBe("Sodium");
  });

  it("skips child Observation entries with entered-in-error status", () => {
    const goodObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-good",
      status: "final",
      code: { text: "Glucose" },
      valueQuantity: { value: 95, unit: "mg/dL" },
    };
    const badObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-bad",
      status: "entered-in-error",
      code: { text: "Bad reading" },
      valueQuantity: { value: 99999, unit: "mg/dL" },
    };
    const observations = new Map<string, InboundObservation>([
      ["obs-good", goodObs],
      ["obs-bad", badObs],
    ]);
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "BMP" },
      result: [
        { reference: "Observation/obs-good" },
        { reference: "Observation/obs-bad" },
      ],
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID, observations);
    expect(mapped!.results).toHaveLength(1);
    expect(mapped!.results[0]!.test_name).toBe("Glucose");
  });

  it("skips observations without numeric valueQuantity (defers string/coded results to a follow-up)", () => {
    const codedObs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-coded",
      status: "final",
      code: { text: "Blood type" },
      // No valueQuantity — typically a valueCodeableConcept on the wire.
    };
    const observations = new Map<string, InboundObservation>([["obs-coded", codedObs]]);
    const report: InboundDiagnosticReport = {
      resourceType: "DiagnosticReport",
      status: "final",
      code: { text: "Blood typing" },
      result: [{ reference: "Observation/obs-coded" }],
    };
    const mapped = mapFhirDiagnosticReportToRow(report, PATIENT_ID, observations);
    expect(mapped!.results).toEqual([]);
  });
});

describe("mapLabObservationToResultRow (#337)", () => {
  it("flags hemoglobin as critical when interpretation carries an HH code", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      code: { text: "Hemoglobin" },
      valueQuantity: { value: 4.1, unit: "g/dL" },
      interpretation: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
              code: "LL",
            },
          ],
        },
      ],
    };
    const row = mapLabObservationToResultRow(obs);
    expect(row!.flag).toBe("critical");
  });

  it("uses valueQuantity.code as the unit fallback when unit is absent", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      code: { text: "Potassium" },
      valueQuantity: { value: 4.0, code: "mEq/L" },
    };
    const row = mapLabObservationToResultRow(obs);
    expect(row!.unit).toBe("mEq/L");
  });

  it("returns null when the observation has no LOINC and no display name", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      code: {},
      valueQuantity: { value: 1, unit: "mg/dL" },
    };
    expect(mapLabObservationToResultRow(obs)).toBeNull();
  });

  it("returns null when valueQuantity is missing or non-numeric", () => {
    expect(
      mapLabObservationToResultRow({
        resourceType: "Observation",
        status: "final",
        code: { text: "X" },
      }),
    ).toBeNull();
    expect(
      mapLabObservationToResultRow({
        resourceType: "Observation",
        status: "final",
        code: { text: "X" },
        valueQuantity: { unit: "mg/dL" },
      }),
    ).toBeNull();
  });

  it("falls back to free-text interpretation when no V3 code is present", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      code: { text: "WBC" },
      valueQuantity: { value: 18, unit: "10*3/uL" },
      interpretation: [{ text: "High" }],
    };
    expect(mapLabObservationToResultRow(obs)!.flag).toBe("H");
  });
});

describe("status mapping (#337)", () => {
  it("imports every status except entered-in-error", () => {
    expect(shouldImportDiagnosticReport("final")).toBe(true);
    expect(shouldImportDiagnosticReport("preliminary")).toBe(true);
    expect(shouldImportDiagnosticReport("partial")).toBe(true);
    expect(shouldImportDiagnosticReport("amended")).toBe(true);
    expect(shouldImportDiagnosticReport("corrected")).toBe(true);
    expect(shouldImportDiagnosticReport("appended")).toBe(true);
    expect(shouldImportDiagnosticReport("registered")).toBe(true);
    expect(shouldImportDiagnosticReport("unknown")).toBe(true);
    expect(shouldImportDiagnosticReport(undefined)).toBe(true);
    expect(shouldImportDiagnosticReport("entered-in-error")).toBe(false);
    expect(shouldImportDiagnosticReport("ENTERED-IN-ERROR")).toBe(false);
  });
});

describe("name and code extraction helpers (#337)", () => {
  it("extractPanelName prefers text, then coding.display", () => {
    expect(extractPanelName({ text: "CBC" })).toBe("CBC");
    expect(extractPanelName({ coding: [{ display: "CBC" }] })).toBe("CBC");
    expect(extractPanelName({})).toBeNull();
    expect(extractPanelName(undefined)).toBeNull();
  });

  it("extractPanelLoinc returns the first LOINC-coded entry only", () => {
    expect(
      extractPanelLoinc({
        coding: [
          { system: "other", code: "X" },
          { system: "http://loinc.org", code: "58410-2" },
        ],
      }),
    ).toBe("58410-2");
    expect(
      extractPanelLoinc({ coding: [{ system: "other", code: "X" }] }),
    ).toBeNull();
    expect(extractPanelLoinc(undefined)).toBeNull();
  });

  it("resolvePractitionerReference parses Practitioner/{id}", () => {
    expect(resolvePractitionerReference({ reference: "Practitioner/p1" })).toBe("p1");
    expect(resolvePractitionerReference({ reference: "Patient/p1" })).toBeNull();
    expect(resolvePractitionerReference(undefined)).toBeNull();
  });

  it("normaliseObservationReference handles typed, urn:uuid, and bare refs", () => {
    expect(normaliseObservationReference({ reference: "Observation/o1" })).toBe("o1");
    expect(normaliseObservationReference({ reference: "urn:uuid:abc" })).toBe("abc");
    expect(normaliseObservationReference({ reference: "o1" })).toBe("o1");
    expect(normaliseObservationReference(undefined)).toBeNull();
    expect(normaliseObservationReference({ reference: "" })).toBeNull();
  });
});

describe("indexBundleObservations (#337)", () => {
  it("indexes Observation entries by both bare id and urn:uuid fullUrl", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-1",
      status: "final",
      code: { text: "Na" },
      valueQuantity: { value: 140, unit: "mEq/L" },
    };
    const map = indexBundleObservations([
      { fullUrl: "urn:uuid:abc-123", resource: obs },
    ]);
    expect(map.get("obs-1")).toBe(obs);
    expect(map.get("abc-123")).toBe(obs);
  });

  it("ignores non-Observation entries", () => {
    const map = indexBundleObservations([
      { resource: { resourceType: "Patient", id: "p-1" } },
      {
        resource: {
          resourceType: "Observation",
          id: "obs-2",
        },
      },
    ]);
    expect(map.has("p-1")).toBe(false);
    expect(map.has("obs-2")).toBe(true);
  });
});
