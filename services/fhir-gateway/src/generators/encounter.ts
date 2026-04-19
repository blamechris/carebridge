/**
 * FHIR R4 Encounter resource generator (issue #387).
 *
 * Maps internal encounter rows to the HL7 FHIR R4 Encounter resource
 * (https://hl7.org/fhir/R4/encounter.html). The internal `encounter_type`
 * maps to Encounter.class using the HL7 v3 ActCode system; the internal
 * `status` aligns to the FHIR EncounterStatus value set (mostly identical
 * strings, with a fallback to "unknown" for unrecognised values).
 */

import type { encounters } from "@carebridge/db-schema";
import type { FhirEncounter } from "../types/fhir-r4.js";

type EncounterRow = typeof encounters.$inferSelect;

/**
 * HL7 v3 ActCode system used for Encounter.class. FHIR R4 requires
 * exactly this URL.
 */
const ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";

/**
 * Map internal encounter_type → HL7 v3 ActCode coding for FHIR
 * Encounter.class.
 *
 * Telehealth is coded as VR (virtual) in FHIR R4; some integrations also
 * use HH (home). VR is more explicit about the remote modality.
 */
function mapEncounterClass(encounterType: string): { code: string; display: string } {
  switch (encounterType.toLowerCase()) {
    case "inpatient":
      return { code: "IMP", display: "inpatient encounter" };
    case "outpatient":
    case "ambulatory":
      return { code: "AMB", display: "ambulatory" };
    case "emergency":
    case "ed":
      return { code: "EMER", display: "emergency" };
    case "telehealth":
    case "virtual":
      return { code: "VR", display: "virtual" };
    case "home":
      return { code: "HH", display: "home health" };
    case "observation":
      return { code: "OBSENC", display: "observation encounter" };
    default:
      return { code: "AMB", display: "ambulatory" };
  }
}

/**
 * FHIR R4 EncounterStatus value set. Narrower than the internal enum, so
 * unknown/custom statuses fall through to "unknown".
 */
const FHIR_ENCOUNTER_STATUSES = new Set<FhirEncounter["status"]>([
  "planned",
  "arrived",
  "triaged",
  "in-progress",
  "onleave",
  "finished",
  "cancelled",
  "entered-in-error",
  "unknown",
]);

function mapEncounterStatus(status: string): FhirEncounter["status"] {
  const normalized = status.toLowerCase() as FhirEncounter["status"];
  return FHIR_ENCOUNTER_STATUSES.has(normalized) ? normalized : "unknown";
}

export function toFhirEncounter(
  encounter: EncounterRow,
  patientId: string,
): FhirEncounter {
  const klass = mapEncounterClass(encounter.encounter_type);

  const resource: FhirEncounter = {
    resourceType: "Encounter",
    id: encounter.id,
    status: mapEncounterStatus(encounter.status),
    class: {
      system: ACT_CODE_SYSTEM,
      code: klass.code,
      display: klass.display,
    },
    subject: {
      reference: `Patient/${patientId}`,
    },
  };

  // Period: start_time is required on the internal row; end_time is
  // optional (open-ended for in-progress encounters).
  const period: { start: string; end?: string } = { start: encounter.start_time };
  if (encounter.end_time) period.end = encounter.end_time;
  resource.period = period;

  if (encounter.provider_id) {
    resource.participant = [
      {
        individual: {
          reference: `Practitioner/${encounter.provider_id}`,
        },
      },
    ];
  }

  if (encounter.reason) {
    resource.reasonCode = [{ text: encounter.reason }];
  }

  // Encounter.location — the internal `location` column is a free-text
  // identifier (bed, unit, clinic room). FHIR R4 wants a Location
  // Reference, so we emit a reference whose `display` carries the
  // internal string. When a proper Location resource set exists the
  // reference string can be upgraded to `Location/<id>`.
  if (encounter.location) {
    resource.location = [
      {
        location: {
          display: encounter.location,
        },
      },
    ];
  }

  return resource;
}
