/**
 * Inbound FHIR Observation → internal vitals / lab_results row mapper
 * tests (#337).
 *
 * Observation is the trickiest inbound mapper because the same FHIR
 * resource type routes to two different internal tables based on
 * Observation.category[].coding[].code:
 *   - vital-signs  → vitals
 *   - laboratory   → lab_results
 *
 * The mapper exposes:
 *   - classifyObservationCategory: returns the routing decision (or null
 *     when the category is missing — caller-decided fallback).
 *   - mapFhirObservationToVitalRow:      → MappedVitalRow | null
 *   - mapFhirObservationToLabResultRow:  → MappedLabResultRow | null
 *
 * Both row mappers return null on:
 *   - missing LOINC code / value
 *   - status: entered-in-error
 *   - unmappable resource (no effective time, etc.)
 */
import { describe, it, expect } from "vitest";
import {
  classifyObservationCategory,
  mapFhirObservationToVitalRow,
  mapFhirObservationToLabResultRow,
  extractEffectiveTime,
  extractLoincCode,
  extractValueQuantity,
  type InboundObservation,
} from "../observation-mapper.js";

const PATIENT_ID = "patient-337";

// ── classifyObservationCategory ────────────────────────────────

describe("classifyObservationCategory (#337)", () => {
  it("returns 'vital-signs' when category coding contains the canonical vital-signs code", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "vital-signs",
              display: "Vital Signs",
            },
          ],
        },
      ],
      code: { text: "BP" },
    };
    expect(classifyObservationCategory(obs)).toBe("vital-signs");
  });

  it("returns 'laboratory' when category coding contains the laboratory code", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/observation-category",
              code: "laboratory",
              display: "Laboratory",
            },
          ],
        },
      ],
      code: { text: "Glucose" },
    };
    expect(classifyObservationCategory(obs)).toBe("laboratory");
  });

  it("ignores category coding system when only the code is present (tolerant)", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { text: "HR" },
    };
    expect(classifyObservationCategory(obs)).toBe("vital-signs");
  });

  it("returns null when category is missing (caller decides fallback)", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      code: { text: "Unknown" },
    };
    expect(classifyObservationCategory(obs)).toBeNull();
  });

  it("returns null when category has no recognised coding", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "social-history" }] }],
      code: { text: "Smoking" },
    };
    expect(classifyObservationCategory(obs)).toBeNull();
  });

  it("picks vital-signs when multiple categories include it", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [
        { coding: [{ code: "exam" }] },
        { coding: [{ code: "vital-signs" }] },
      ],
      code: { text: "HR" },
    };
    expect(classifyObservationCategory(obs)).toBe("vital-signs");
  });
});

// ── helpers ────────────────────────────────────────────────────

describe("extractLoincCode (#337)", () => {
  it("returns the LOINC-coded entry", () => {
    expect(
      extractLoincCode({
        code: {
          coding: [
            { system: "other", code: "X" },
            { system: "http://loinc.org", code: "8867-4", display: "Heart rate" },
          ],
        },
      }),
    ).toBe("8867-4");
  });

  it("returns null when no LOINC coding is present", () => {
    expect(
      extractLoincCode({ code: { coding: [{ system: "other", code: "X" }] } }),
    ).toBeNull();
    expect(extractLoincCode({ code: { text: "free text only" } })).toBeNull();
  });

  it("returns null when the code field is absent", () => {
    expect(extractLoincCode({} as unknown as InboundObservation)).toBeNull();
  });
});

describe("extractValueQuantity (#337)", () => {
  it("returns value + unit when both present", () => {
    expect(
      extractValueQuantity({
        valueQuantity: { value: 72, unit: "bpm", code: "/min" },
      }),
    ).toEqual({ value: 72, unit: "bpm" });
  });

  it("falls back to code as unit when unit is absent", () => {
    expect(
      extractValueQuantity({ valueQuantity: { value: 100, code: "mg/dL" } }),
    ).toEqual({ value: 100, unit: "mg/dL" });
  });

  it("returns null when value is missing", () => {
    expect(extractValueQuantity({ valueQuantity: { unit: "bpm" } })).toBeNull();
  });

  it("returns null when valueQuantity is absent", () => {
    expect(extractValueQuantity({})).toBeNull();
  });
});

describe("extractEffectiveTime (#337)", () => {
  it("returns effectiveDateTime when present", () => {
    expect(
      extractEffectiveTime({
        effectiveDateTime: "2026-05-22T10:00:00.000Z",
      } as InboundObservation),
    ).toBe("2026-05-22T10:00:00.000Z");
  });

  it("falls back to effectivePeriod.start", () => {
    expect(
      extractEffectiveTime({
        effectivePeriod: { start: "2026-05-22T09:00:00.000Z" },
      } as InboundObservation),
    ).toBe("2026-05-22T09:00:00.000Z");
  });

  it("returns null when neither is set", () => {
    expect(extractEffectiveTime({} as InboundObservation)).toBeNull();
  });
});

// ── mapFhirObservationToVitalRow ───────────────────────────────

describe("mapFhirObservationToVitalRow (#337)", () => {
  it("maps a heart-rate Observation to a vitals row", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-hr",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: {
        coding: [
          { system: "http://loinc.org", code: "8867-4", display: "Heart rate" },
        ],
        text: "Heart rate",
      },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 72, unit: "bpm", code: "/min" },
    };
    const row = mapFhirObservationToVitalRow(obs, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      patient_id: PATIENT_ID,
      type: "heart_rate",
      loinc_code: "8867-4",
      value_primary: 72,
      value_secondary: null,
      unit: "bpm",
      recorded_at: "2026-05-22T10:00:00.000Z",
      source_system: "fhir_import",
    });
  });

  it("maps an O2 sat Observation", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: {
        coding: [{ system: "http://loinc.org", code: "59408-5" }],
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 98, unit: "%", code: "%" },
    };
    const row = mapFhirObservationToVitalRow(obs, PATIENT_ID);
    expect(row?.type).toBe("o2_sat");
    expect(row?.value_primary).toBe(98);
    expect(row?.unit).toBe("%");
  });

  it("maps a blood-pressure Observation with component[] (systolic + diastolic)", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: {
        coding: [
          { system: "http://loinc.org", code: "85354-9", display: "Blood pressure panel" },
        ],
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      component: [
        {
          code: {
            coding: [
              { system: "http://loinc.org", code: "8480-6", display: "Systolic" },
            ],
          },
          valueQuantity: { value: 120, unit: "mmHg", code: "mm[Hg]" },
        },
        {
          code: {
            coding: [
              { system: "http://loinc.org", code: "8462-4", display: "Diastolic" },
            ],
          },
          valueQuantity: { value: 80, unit: "mmHg", code: "mm[Hg]" },
        },
      ],
    };
    const row = mapFhirObservationToVitalRow(obs, PATIENT_ID);
    expect(row).not.toBeNull();
    expect(row!.type).toBe("blood_pressure");
    expect(row!.value_primary).toBe(120);
    expect(row!.value_secondary).toBe(80);
    expect(row!.unit).toBe("mmHg");
  });

  it("returns null on status: entered-in-error", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "entered-in-error",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 72, unit: "bpm" },
    };
    expect(mapFhirObservationToVitalRow(obs, PATIENT_ID)).toBeNull();
  });

  it("returns null when LOINC code does not map to a VitalType", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "99999-9" }] },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 1, unit: "x" },
    };
    expect(mapFhirObservationToVitalRow(obs, PATIENT_ID)).toBeNull();
  });

  it("returns null when value is missing", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
    };
    expect(mapFhirObservationToVitalRow(obs, PATIENT_ID)).toBeNull();
  });

  it("returns null when effective time is missing", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      valueQuantity: { value: 72, unit: "bpm" },
    };
    expect(mapFhirObservationToVitalRow(obs, PATIENT_ID)).toBeNull();
  });

  it("falls back to effectivePeriod.start when effectiveDateTime absent", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "vital-signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      effectivePeriod: { start: "2026-05-21T08:00:00.000Z" },
      valueQuantity: { value: 65, unit: "bpm" },
    };
    expect(mapFhirObservationToVitalRow(obs, PATIENT_ID)?.recorded_at).toBe(
      "2026-05-21T08:00:00.000Z",
    );
  });
});

// ── mapFhirObservationToLabResultRow ───────────────────────────

describe("mapFhirObservationToLabResultRow (#337)", () => {
  it("maps a glucose Observation to a lab_results row", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      id: "obs-glu",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: {
        coding: [
          { system: "http://loinc.org", code: "2339-0", display: "Glucose" },
        ],
        text: "Glucose",
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 95, unit: "mg/dL", code: "mg/dL" },
    };
    const row = mapFhirObservationToLabResultRow(obs);
    expect(row).not.toBeNull();
    expect(row!).toEqual({
      test_name: "Glucose",
      test_code: "2339-0",
      value: 95,
      unit: "mg/dL",
      reference_low: null,
      reference_high: null,
      flag: null,
      recorded_at: "2026-05-22T10:00:00.000Z",
    });
  });

  it("extracts reference range low and high", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: {
        coding: [
          { system: "http://loinc.org", code: "6690-2", display: "WBC" },
        ],
        text: "WBC",
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 7.5, unit: "K/uL", code: "10*3/uL" },
      referenceRange: [
        {
          low: { value: 4.5, unit: "K/uL" },
          high: { value: 11.0, unit: "K/uL" },
        },
      ],
    };
    const row = mapFhirObservationToLabResultRow(obs);
    expect(row?.reference_low).toBe(4.5);
    expect(row?.reference_high).toBe(11.0);
  });

  it("maps interpretation H/L/critical flags", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: {
        coding: [{ system: "http://loinc.org", code: "2339-0" }],
        text: "Glucose",
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 250, unit: "mg/dL" },
      interpretation: [
        {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
              code: "H",
            },
          ],
        },
      ],
    };
    expect(mapFhirObservationToLabResultRow(obs)?.flag).toBe("H");
  });

  it("falls back to code.text when no LOINC code is present", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Custom assay" },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 1, unit: "x" },
    };
    const row = mapFhirObservationToLabResultRow(obs);
    expect(row?.test_name).toBe("Custom assay");
    expect(row?.test_code).toBeNull();
  });

  it("returns null on status: entered-in-error", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "entered-in-error",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: {
        coding: [{ system: "http://loinc.org", code: "2339-0" }],
        text: "Glucose",
      },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 95, unit: "mg/dL" },
    };
    expect(mapFhirObservationToLabResultRow(obs)).toBeNull();
  });

  it("returns null when value is missing", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text: "Glucose" },
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
    };
    expect(mapFhirObservationToLabResultRow(obs)).toBeNull();
  });

  it("returns null when test name cannot be resolved", () => {
    const obs: InboundObservation = {
      resourceType: "Observation",
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: {},
      effectiveDateTime: "2026-05-22T10:00:00.000Z",
      valueQuantity: { value: 1, unit: "x" },
    };
    expect(mapFhirObservationToLabResultRow(obs)).toBeNull();
  });
});
