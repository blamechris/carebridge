import type { Vital, VitalType, LabResult } from "@carebridge/shared-types";
import { VITAL_LOINC_CODES } from "@carebridge/shared-types";
import type {
  Coding,
  CodeableConcept,
  Quantity,
  Reference,
  ObservationComponent,
} from "../types/fhir-r4.js";

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

const UCUM_SYSTEM = "http://unitsofmeasure.org";

/**
 * Map every stored-vital-unit form we have ever seen to its UCUM atom.
 * Keys are matched case-insensitively (see `vitalUnitToUcum` below).
 *
 * Issue #985: the original implementation IGNORED `vital.unit` and emitted
 * the same hardcoded UCUM atom per VitalType (temperature → [degF],
 * weight → [lb_av]). A row stored as `{value: 37, unit: "degC"}` exported
 * as Fahrenheit — a 37 °C reading reads as severe hypothermia downstream.
 * The fix reads vital.unit and emits the UCUM atom that matches the
 * stored unit, preserving data fidelity end-to-end.
 */
const VITAL_UNIT_TO_UCUM: Record<string, string> = {
  // Temperature
  "°c": "Cel",
  "degc": "Cel",
  "c": "Cel",
  "cel": "Cel",
  "celsius": "Cel",
  "°f": "[degF]",
  "degf": "[degF]",
  "f": "[degF]",
  "[degf]": "[degF]",
  "fahrenheit": "[degF]",
  // Weight
  "kg": "kg",
  "kilogram": "kg",
  "kilograms": "kg",
  "g": "g",
  "lb": "[lb_av]",
  "lbs": "[lb_av]",
  "pound": "[lb_av]",
  "pounds": "[lb_av]",
  "[lb_av]": "[lb_av]",
  // Blood pressure
  "mmhg": "mm[Hg]",
  "mm[hg]": "mm[Hg]",
  // Rate / count
  "bpm": "/min",
  "beats/min": "/min",
  "beats/minute": "/min",
  "breaths/min": "/min",
  "breaths/minute": "/min",
  "/min": "/min",
  "1/min": "/min",
  // Saturation / percent
  "%": "%",
  "percent": "%",
  // Score
  "/10": "{score}",
  "score": "{score}",
  "{score}": "{score}",
  // Glucose / concentration
  "mg/dl": "mg/dL",
  "mmol/l": "mmol/L",
};

function vitalUnitToUcum(unit: string | null | undefined): string | undefined {
  if (!unit) return undefined;
  return VITAL_UNIT_TO_UCUM[unit.trim().toLowerCase()];
}

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

/**
 * Build a FHIR Quantity from a vital's stored value + unit. When the stored
 * unit maps to a recognised UCUM atom we emit a fully-coded Quantity
 * (system + code); when it does not, we emit value + unit only — preserving
 * the original reading without lying under the UCUM URL.
 *
 * Critically: this reads `vital.unit` — it does NOT consult a per-VitalType
 * default. A Celsius-stored temperature must export as Cel, never [degF].
 */
function vitalQuantity(value: number, storedUnit: string): Quantity {
  const ucumCode = vitalUnitToUcum(storedUnit);
  if (ucumCode) {
    return {
      value,
      unit: ucumCode,
      system: UCUM_SYSTEM,
      code: ucumCode,
    };
  }
  return { value, unit: storedUnit };
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
        valueQuantity: vitalQuantity(vital.value_primary, vital.unit),
      },
      {
        code: {
          coding: [loincCoding("8462-4", "Diastolic blood pressure")],
        },
        valueQuantity: vitalQuantity(
          vital.value_secondary ?? 0,
          vital.unit,
        ),
      },
    ];
  } else {
    observation.valueQuantity = vitalQuantity(vital.value_primary, vital.unit);
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
