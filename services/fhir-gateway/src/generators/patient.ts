import type { FhirPatient } from "../types/index.js";

/** Shape of a row from the `patients` table after decryption. */
interface PatientRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  biological_sex: string | null;
  mrn: string | null;
}

const GENDER_MAP: Record<string, FhirPatient["gender"]> = {
  male: "male",
  female: "female",
  other: "other",
  m: "male",
  f: "female",
};

/**
 * Parse a full name string into FHIR HumanName parts.
 * Splits on the last space: everything before is `given`, the last token is `family`.
 * A single-token name is treated as `family`.
 */
function parseName(fullName: string): { family: string; given: string[] } {
  const trimmed = fullName.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) {
    return { family: trimmed, given: [] };
  }
  return {
    family: trimmed.slice(lastSpace + 1),
    given: trimmed.slice(0, lastSpace).split(/\s+/),
  };
}

/**
 * Convert a CareBridge patient DB row to a FHIR R4 Patient resource
 * conforming to the US Core Patient profile.
 */
export function toFhirPatient(patient: PatientRow): FhirPatient {
  const { family, given } = parseName(patient.name);

  const gender: FhirPatient["gender"] =
    GENDER_MAP[(patient.biological_sex ?? "").toLowerCase()] ?? "unknown";

  const resource: FhirPatient = {
    resourceType: "Patient",
    id: patient.id,
    meta: {
      profile: [
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
      ],
    },
    identifier: patient.mrn
      ? [
          {
            use: "usual",
            type: {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                  code: "MR",
                  display: "Medical Record Number",
                },
              ],
            },
            system: "http://carebridge.health/mrn",
            value: patient.mrn,
          },
        ]
      : undefined,
    name: [
      {
        use: "official",
        family,
        given: given.length > 0 ? given : undefined,
        text: patient.name.trim(),
      },
    ],
    gender,
  };

  if (patient.date_of_birth) {
    // Ensure YYYY-MM-DD format (strip any time component)
    resource.birthDate = patient.date_of_birth.slice(0, 10);
  }

  return resource;
}
