/**
 * FHIR R4 MedicationStatement resource generator.
 *
 * Maps internal medication records to the HL7 FHIR R4 MedicationStatement
 * resource (https://hl7.org/fhir/R4/medicationstatement.html), including
 * RxNorm coding and structured dosage information.
 */

import type { medications } from "@carebridge/db-schema";
import type { Coding, Period, Reference } from "../types/fhir-r4.js";

type Medication = typeof medications.$inferSelect;

interface FhirDosage {
  text?: string;
  timing?: {
    code?: {
      text: string;
    };
  };
  route?: {
    coding?: Coding[];
    text: string;
  };
  doseAndRate?: {
    doseQuantity: {
      value: number;
      unit: string;
      system: string;
      code: string;
    };
  }[];
}

interface FhirMedicationStatement {
  resourceType: "MedicationStatement";
  id: string;
  status: string;
  medicationCodeableConcept: {
    coding: Coding[];
    text: string;
  };
  subject: Reference;
  effectivePeriod?: Period;
  dateAsserted?: string;
  informationSource?: Reference;
  dosage?: FhirDosage[];
  note?: { text: string }[];
}

function mapMedicationStatus(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "discontinued":
    case "stopped":
      return "stopped";
    case "on-hold":
      return "on-hold";
    default:
      return "unknown";
  }
}

/**
 * Convert an internal medication record to a FHIR R4 MedicationStatement resource.
 */
export function toFhirMedicationStatement(
  medication: Medication,
  patientId: string,
): FhirMedicationStatement {
  const codings: Coding[] = [];

  if (medication.rxnorm_code) {
    codings.push({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: medication.rxnorm_code,
      display: medication.name,
    });
  }

  // Always include a text-based entry for the medication name
  if (codings.length === 0) {
    codings.push({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "unknown",
      display: medication.name,
    });
  }

  const statement: FhirMedicationStatement = {
    resourceType: "MedicationStatement",
    id: medication.id,
    status: mapMedicationStatus(medication.status),
    medicationCodeableConcept: {
      coding: codings,
      text: medication.brand_name
        ? `${medication.name} (${medication.brand_name})`
        : medication.name,
    },
    subject: {
      reference: `Patient/${patientId}`,
    },
  };

  // Effective period
  if (medication.started_at || medication.ended_at) {
    statement.effectivePeriod = {};
    if (medication.started_at) {
      statement.effectivePeriod.start = medication.started_at;
    }
    if (medication.ended_at) {
      statement.effectivePeriod.end = medication.ended_at;
    }
  }

  if (medication.created_at) {
    statement.dateAsserted = medication.created_at;
  }

  if (medication.prescribed_by) {
    statement.informationSource = {
      reference: `Practitioner/${medication.prescribed_by}`,
    };
  }

  // Dosage
  const dosage: FhirDosage = {};
  let hasDosage = false;

  if (medication.frequency) {
    dosage.timing = {
      code: { text: medication.frequency },
    };
    hasDosage = true;
  }

  if (medication.route) {
    dosage.route = {
      text: medication.route,
    };
    hasDosage = true;
  }

  if (medication.dose_amount != null && medication.dose_unit) {
    dosage.doseAndRate = [
      {
        doseQuantity: {
          value: medication.dose_amount,
          unit: medication.dose_unit,
          system: "http://unitsofmeasure.org",
          code: medication.dose_unit,
        },
      },
    ];
    hasDosage = true;
  }

  if (hasDosage) {
    // Build descriptive text
    const parts: string[] = [];
    if (medication.dose_amount != null && medication.dose_unit) {
      parts.push(`${medication.dose_amount} ${medication.dose_unit}`);
    }
    if (medication.route) {
      parts.push(medication.route);
    }
    if (medication.frequency) {
      parts.push(medication.frequency);
    }
    dosage.text = parts.join(" ");
    statement.dosage = [dosage];
  }

  if (medication.notes) {
    statement.note = [{ text: medication.notes }];
  }

  return statement;
}
