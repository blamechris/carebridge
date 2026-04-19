/**
 * FHIR R4 MedicationRequest resource generator (issue #388).
 *
 * Epic (and most EHRs that consume FHIR R4) expect active prescriptions
 * as MedicationRequest resources — MedicationStatement is for recorded
 * current / historical meds the patient reports taking, not for orders.
 * Both formats remain so the exported bundle round-trips cleanly in
 * either direction.
 *
 * Mapping conventions mirror medication-statement.ts where the underlying
 * fields overlap (RxNorm coding, route SNOMED, dose in UCUM-like unit)
 * so downstream consumers see consistent data shapes.
 */

import type { medications } from "@carebridge/db-schema";
import type {
  FhirMedicationRequest,
  Coding,
  DosageInstruction,
} from "../types/fhir-r4.js";

type Medication = typeof medications.$inferSelect;

type FhirCoding = Required<Pick<Coding, "system" | "code">> & Pick<Coding, "display">;

/**
 * SNOMED route codings, shared shape with medication-statement.ts. Kept
 * local here to avoid reaching across generator boundaries for a private
 * table.
 */
const ROUTE_SNOMED: Record<string, { code: string; display: string }> = {
  oral: { code: "26643006", display: "Oral route" },
  IV: { code: "47625008", display: "Intravenous route" },
  IM: { code: "78421000", display: "Intramuscular route" },
  subcutaneous: { code: "34206005", display: "Subcutaneous route" },
  topical: { code: "6064005", display: "Topical route" },
  inhaled: { code: "418730005", display: "Inhalation route" },
  rectal: { code: "37161004", display: "Rectal route" },
  other: { code: "284009009", display: "Route of administration" },
};

/**
 * FHIR R4 MedicationRequest status value set (narrower than
 * MedicationStatement):
 *   active | on-hold | cancelled | completed | entered-in-error |
 *   stopped | draft | unknown
 */
function mapRequestStatus(status: string): FhirMedicationRequest["status"] {
  switch (status.toLowerCase()) {
    case "active":
      return "active";
    case "held":
    case "on-hold":
      return "on-hold";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "completed":
      return "completed";
    case "discontinued":
    case "stopped":
      return "stopped";
    case "draft":
    case "proposed":
      return "draft";
    case "entered-in-error":
      return "entered-in-error";
    default:
      return "unknown";
  }
}

export function toFhirMedicationRequest(
  medication: Medication,
  patientId: string,
): FhirMedicationRequest {
  const codings: FhirCoding[] = [];

  if (medication.rxnorm_code) {
    codings.push({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: medication.rxnorm_code,
      display: medication.name,
    });
  }

  if (codings.length === 0) {
    codings.push({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "unknown",
      display: medication.name,
    });
  }

  const resource: FhirMedicationRequest = {
    resourceType: "MedicationRequest",
    id: medication.id,
    status: mapRequestStatus(medication.status),
    // CareBridge-internal medications are prescription orders; there's no
    // plan-vs-order distinction in the current data model, so we emit
    // "order" (a concrete, actionable request) per the FHIR value set.
    intent: "order",
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

  if (medication.started_at) {
    resource.authoredOn = medication.started_at;
  }

  // Requester: ordering_provider_id is the canonical prescriber; fall
  // back to the older prescribed_by column for rows written before the
  // field split.
  const prescriberId = medication.ordering_provider_id ?? medication.prescribed_by;
  if (prescriberId) {
    resource.requester = {
      reference: `Practitioner/${prescriberId}`,
    };
  }

  // Dosage instruction — fields mirror the MedicationStatement shape so
  // a single downstream renderer can handle both.
  const dosage: DosageInstruction = {};
  let hasDosage = false;

  if (medication.frequency) {
    dosage.timing = {
      code: { text: medication.frequency },
    };
    hasDosage = true;
  }

  if (medication.route) {
    const snomed = ROUTE_SNOMED[medication.route];
    dosage.route = {
      coding: snomed
        ? [
            {
              system: "http://snomed.info/sct",
              code: snomed.code,
              display: snomed.display,
            },
          ]
        : undefined,
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
    const parts: string[] = [];
    if (medication.dose_amount != null && medication.dose_unit) {
      parts.push(`${medication.dose_amount} ${medication.dose_unit}`);
    }
    if (medication.route) parts.push(medication.route);
    if (medication.frequency) parts.push(medication.frequency);
    dosage.text = parts.join(" ");
    resource.dosageInstruction = [dosage];
  }

  return resource;
}
