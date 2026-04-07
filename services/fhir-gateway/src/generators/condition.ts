/**
 * FHIR R4 Condition resource generator.
 *
 * Maps internal diagnosis records to the HL7 FHIR R4 Condition resource
 * (https://hl7.org/fhir/R4/condition.html), including ICD-10 and optional
 * SNOMED CT coding.
 */

import type { diagnoses } from "@carebridge/db-schema";
import type { Coding } from "../types/fhir-r4.js";

type Diagnosis = typeof diagnoses.$inferSelect;

// Local alias: Condition codings are always fully populated.
type FhirCoding = Required<Pick<Coding, "system" | "code">> & Pick<Coding, "display">;

interface FhirCondition {
  resourceType: "Condition";
  id: string;
  clinicalStatus: {
    coding: FhirCoding[];
  };
  verificationStatus: {
    coding: FhirCoding[];
  };
  code: {
    coding: FhirCoding[];
    text: string;
  };
  subject: {
    reference: string;
  };
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  recorder?: {
    reference: string;
  };
}

const CLINICAL_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-clinical";

const VERIFICATION_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status";

function mapClinicalStatus(status: string): string {
  switch (status) {
    case "active":
    case "chronic":
      return "active";
    case "resolved":
      return "resolved";
    default:
      return "active";
  }
}

/**
 * Convert an internal diagnosis record to a FHIR R4 Condition resource.
 */
export function toFhirCondition(
  diagnosis: Diagnosis,
  patientId: string,
): FhirCondition {
  const codings: FhirCoding[] = [];

  if (diagnosis.icd10_code) {
    codings.push({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: diagnosis.icd10_code,
      display: diagnosis.description,
    });
  }

  if (diagnosis.snomed_code) {
    codings.push({
      system: "http://snomed.info/sct",
      code: diagnosis.snomed_code,
      display: diagnosis.description,
    });
  }

  // Fallback: if no standard codes, include a text-only coding
  if (codings.length === 0) {
    codings.push({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "unknown",
      display: diagnosis.description,
    });
  }

  const clinicalStatusCode = mapClinicalStatus(diagnosis.status);

  const condition: FhirCondition = {
    resourceType: "Condition",
    id: diagnosis.id,
    clinicalStatus: {
      coding: [
        {
          system: CLINICAL_STATUS_SYSTEM,
          code: clinicalStatusCode,
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: VERIFICATION_STATUS_SYSTEM,
          code: "confirmed",
        },
      ],
    },
    code: {
      coding: codings,
      text: diagnosis.description,
    },
    subject: {
      reference: `Patient/${patientId}`,
    },
  };

  if (diagnosis.onset_date) {
    condition.onsetDateTime = diagnosis.onset_date;
  }

  if (diagnosis.resolved_date) {
    condition.abatementDateTime = diagnosis.resolved_date;
  }

  if (diagnosis.created_at) {
    condition.recordedDate = diagnosis.created_at;
  }

  if (diagnosis.diagnosed_by) {
    condition.recorder = {
      reference: `Practitioner/${diagnosis.diagnosed_by}`,
    };
  }

  return condition;
}
