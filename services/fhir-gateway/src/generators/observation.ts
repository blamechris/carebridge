import type { Vital, VitalType, LabResult } from "@carebridge/shared-types";
import { VITAL_LOINC_CODES } from "@carebridge/shared-types";

const UNIT_TO_UCUM: Record<string, string> = {
  "K/uL": "10*3/uL",
  "M/uL": "10*6/uL",
  "g/dL": "g/dL",
  "mg/dL": "mg/dL",
  "ng/mL": "ng/mL",
  "pg/mL": "pg/mL",
  "mEq/L": "meq/L",
  "mmol/L": "mmol/L",
  "IU/L": "[iU]/L",
  "U/L": "U/L",
  "%": "%",
  "sec": "s",
  "mm/hr": "mm/h",
  "bpm": "/min",
  "breaths/min": "/min",
  "mmHg": "mm[Hg]",
  "kg": "kg",
  "lbs": "[lb_av]",
  "cm": "cm",
  "in": "[in_i]",
};

function toUcumCode(unit: string | null): string {
  if (!unit) return "{unknown}";
  return UNIT_TO_UCUM[unit] ?? unit;
}

// ─── FHIR R4 Types (inline to avoid external dependency) ────────

interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

interface Quantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

interface Reference {
  reference?: string;
}

interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: Quantity;
}

interface ObservationReferenceRange {
  low?: Quantity;
  high?: Quantity;
}

export interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  status: "final" | "preliminary" | "registered" | "amended";
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject?: Reference;
  effectiveDateTime?: string;
  valueQuantity?: Quantity;
  component?: ObservationComponent[];
  referenceRange?: ObservationReferenceRange[];
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

function loincCoding(code: string, display?: string): Coding {
  return {
    system: "http://loinc.org",
    code,
    display,
  };
}

function ucumQuantity(value: number, vitalType: VitalType): Quantity {
  const ucum = UCUM_UNITS[vitalType];
  return {
    value,
    unit: ucum.unit,
    system: "http://unitsofmeasure.org",
    code: ucum.code,
  };
}

function vitalSignsCategory(): CodeableConcept {
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

function laboratoryCategory(): CodeableConcept {
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
        ? [loincCoding(loincCode, VITAL_DISPLAY[vitalType])]
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
    const range: ObservationReferenceRange = {};
    if (labResult.reference_low != null) {
      range.low = {
        value: labResult.reference_low,
        unit: labResult.unit,
        system: "http://unitsofmeasure.org",
        code: toUcumCode(labResult.unit),
      };
    }
    if (labResult.reference_high != null) {
      range.high = {
        value: labResult.reference_high,
        unit: labResult.unit,
        system: "http://unitsofmeasure.org",
        code: toUcumCode(labResult.unit),
      };
    }
    observation.referenceRange = [range];
  }

  return observation;
}
