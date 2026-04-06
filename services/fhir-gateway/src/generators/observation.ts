/**
 * FHIR R4 Observation resource generators.
 *
 * Maps internal vital signs and lab results to the HL7 FHIR R4 Observation
 * resource (https://hl7.org/fhir/R4/observation.html), including LOINC coding
 * and UCUM units.
 */

import type { Vital, VitalType, LabResult } from "@carebridge/shared-types";
import { VITAL_LOINC_CODES } from "@carebridge/shared-types";

// ─── FHIR R4 Types (inline to avoid external dependency) ────────

interface FhirCoding {
  system: string;
  code: string;
  display?: string;
}

interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

interface FhirQuantity {
  value: number;
  unit: string;
  system: string;
  code: string;
}

interface FhirReference {
  reference: string;
}

interface FhirObservationComponent {
  code: FhirCodeableConcept;
  valueQuantity: FhirQuantity;
}

interface FhirReferenceRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  status: "final" | "preliminary" | "registered" | "amended";
  category: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime: string;
  valueQuantity?: FhirQuantity;
  component?: FhirObservationComponent[];
  referenceRange?: FhirReferenceRange[];
}

// ─── UCUM unit mapping ──────────────────────────────────────────

const UCUM_UNITS: Record<VitalType, { unit: string; code: string }> = {
  blood_pressure: { unit: "mmHg", code: "mm[Hg]" },
  heart_rate: { unit: "/min", code: "/min" },
  o2_sat: { unit: "%", code: "%" },
  temperature: { unit: "[degF]", code: "[degF]" },
  weight: { unit: "[lb_av]", code: "[lb_av]" },
  respiratory_rate: { unit: "/min", code: "/min" },
  pain_level: { unit: "{score}", code: "{score}" },
  blood_glucose: { unit: "mg/dL", code: "mg/dL" },
};

const VITAL_DISPLAY: Record<VitalType, string> = {
  blood_pressure: "Blood pressure panel",
  heart_rate: "Heart rate",
  o2_sat: "Oxygen saturation",
  temperature: "Body temperature",
  weight: "Body weight",
  respiratory_rate: "Respiratory rate",
  pain_level: "Pain severity rating",
  blood_glucose: "Glucose [Mass/volume] in Blood",
};

// ─── Helpers ────────────────────────────────────────────────────

function loincCoding(code: string, display: string): FhirCoding {
  return {
    system: "http://loinc.org",
    code,
    display,
  };
}

function ucumQuantity(value: number, vitalType: VitalType): FhirQuantity {
  const ucum = UCUM_UNITS[vitalType];
  return {
    value,
    unit: ucum.unit,
    system: "http://unitsofmeasure.org",
    code: ucum.code,
  };
}

function vitalSignsCategory(): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "vital-signs",
        display: "Vital Signs",
      },
    ],
  };
}

function laboratoryCategory(): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "laboratory",
        display: "Laboratory",
      },
    ],
  };
}

// ─── Vitals ─────────────────────────────────────────────────────

/**
 * Convert an internal vital record to a FHIR R4 Observation resource.
 *
 * Blood pressure vitals use the `component` array with separate systolic and
 * diastolic entries. All other vital types use `valueQuantity`.
 */
export function toFhirVitalObservation(
  vital: Vital,
  patientId: string,
): FhirObservation {
  const vitalType = vital.type as VitalType;
  const loincCode = vital.loinc_code ?? VITAL_LOINC_CODES[vitalType] ?? undefined;

  const observation: FhirObservation = {
    resourceType: "Observation",
    id: vital.id,
    status: "final",
    category: [vitalSignsCategory()],
    code: {
      coding: loincCode
        ? [loincCoding(loincCode, VITAL_DISPLAY[vitalType] ?? vitalType)]
        : undefined,
      text: VITAL_DISPLAY[vitalType] ?? vitalType,
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: vital.recorded_at,
  };

  if (vitalType === "blood_pressure") {
    observation.component = [
      {
        code: {
          coding: [loincCoding("8480-6", "Systolic blood pressure")],
        },
        valueQuantity: ucumQuantity(vital.value_primary, "blood_pressure"),
      },
      {
        code: {
          coding: [loincCoding("8462-4", "Diastolic blood pressure")],
        },
        valueQuantity: ucumQuantity(
          vital.value_secondary ?? 0,
          "blood_pressure",
        ),
      },
    ];
  } else {
    observation.valueQuantity = ucumQuantity(vital.value_primary, vitalType);
  }

  return observation;
}

// ─── Lab Results ────────────────────────────────────────────────

/**
 * Convert an internal lab result record to a FHIR R4 Observation resource.
 *
 * Includes reference ranges when `reference_low` / `reference_high` are
 * present on the source record.
 */
export function toFhirLabObservation(
  labResult: LabResult,
  patientId: string,
): FhirObservation {
  const observation: FhirObservation = {
    resourceType: "Observation",
    id: labResult.id,
    status: "final",
    category: [laboratoryCategory()],
    code: {
      coding: labResult.test_code
        ? [loincCoding(labResult.test_code, labResult.test_name)]
        : undefined,
      text: labResult.test_name,
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: labResult.created_at,
    valueQuantity: {
      value: labResult.value,
      unit: labResult.unit,
      system: "http://unitsofmeasure.org",
      code: labResult.unit,
    },
  };

  if (labResult.reference_low != null || labResult.reference_high != null) {
    const range: FhirReferenceRange = {};
    if (labResult.reference_low != null) {
      range.low = {
        value: labResult.reference_low,
        unit: labResult.unit,
        system: "http://unitsofmeasure.org",
        code: labResult.unit,
      };
    }
    if (labResult.reference_high != null) {
      range.high = {
        value: labResult.reference_high,
        unit: labResult.unit,
        system: "http://unitsofmeasure.org",
        code: labResult.unit,
      };
    }
    observation.referenceRange = [range];
  }

  return observation;
}
