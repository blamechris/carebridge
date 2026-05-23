/**
 * Epic FHIR R4 → CareBridge row converters (#390).
 *
 * Wraps the existing fhir-gateway inbound mappers so that Epic-sourced
 * resources land in the same `patients`, `medications`, `vitals`,
 * `lab_results`, `diagnoses`, `allergies` row shapes as the bundle-
 * import path, but with `source_system: "epic"` instead of
 * `"fhir_import"`. Downstream rows can then be filtered by origin (sync
 * audit, conflict resolution, "where did this medication come from?").
 *
 * Why a wrapper rather than reaching into the mappers and parameterising
 * the source tag:
 *  - Keeps the mappers' invariants (single-line const, easy to grep)
 *  - Keeps the Epic-specific knowledge co-located with the rest of the
 *    Epic connector — fhir-gateway shouldn't know about Epic.
 *  - Future Epic-only post-processing (extension parsing, MyChart
 *    identifier mapping) has an obvious home.
 */
import {
  mapFhirPatientToRow,
  mapMedicationRequestToRow,
  mapMedicationStatementToRow,
  classifyObservationCategory,
  mapFhirObservationToVitalRow,
  mapFhirObservationToLabResultRow,
  mapFhirConditionToRow,
  mapFhirAllergyIntoleranceToRow,
  type InboundPatient,
  type MappedPatientRow,
  type InboundMedicationRequest,
  type InboundMedicationStatement,
  type MappedMedicationRow,
  type InboundObservation,
  type MappedVitalRow,
  type MappedLabResultRow,
  type InboundCondition,
  type MappedDiagnosisRow,
  type InboundAllergyIntolerance,
  type MappedAllergyRow,
  type ObservationCategory,
} from "@carebridge/fhir-gateway";
import type { FhirResource } from "./fhir-types.js";

export const EPIC_SOURCE_SYSTEM_TAG = "epic" as const;

/**
 * Variant of {@link MappedDiagnosisRow} that carries `source_system`.
 * The fhir-gateway mapper omits this field today (the column is
 * populated by the diagnoses writer), but the Epic sync path needs it
 * so callers can tell Epic rows from internally-recorded ones without
 * a JOIN to `epic_sync_state`.
 */
export type EpicDiagnosisRow = MappedDiagnosisRow & {
  source_system: typeof EPIC_SOURCE_SYSTEM_TAG;
};

function withEpicSource<T extends { source_system?: unknown }>(row: T): T {
  return { ...row, source_system: EPIC_SOURCE_SYSTEM_TAG };
}

/**
 * Convert an Epic FHIR Patient to a CareBridge `patients`-row insert.
 * Returns `null` for unmappable resources (no name/MRN, retired patient).
 */
export function epicPatientToRow(
  resource: FhirResource,
): MappedPatientRow | null {
  const mapped = mapFhirPatientToRow(resource as unknown as InboundPatient);
  if (!mapped) return null;
  return withEpicSource(mapped);
}

/**
 * Convert an Epic FHIR MedicationRequest to a CareBridge `medications`-row
 * insert. Returns `null` when the resource lacks a usable medication name
 * or maps to a status we refuse to surface (entered-in-error, etc).
 */
export function epicMedicationRequestToRow(
  resource: FhirResource,
  patientId: string,
): MappedMedicationRow | null {
  const mapped = mapMedicationRequestToRow(
    resource as unknown as InboundMedicationRequest,
    patientId,
  );
  if (!mapped) return null;
  return withEpicSource(mapped);
}

/**
 * Convert an Epic FHIR MedicationStatement to a CareBridge `medications`-row
 * insert. Useful for med-rec pulls where Epic returns prior outpatient meds
 * as Statements rather than Requests.
 */
export function epicMedicationStatementToRow(
  resource: FhirResource,
  patientId: string,
): MappedMedicationRow | null {
  const mapped = mapMedicationStatementToRow(
    resource as unknown as InboundMedicationStatement,
    patientId,
  );
  if (!mapped) return null;
  return withEpicSource(mapped);
}

/**
 * Classify and convert an Epic FHIR Observation. The Observation type
 * fans out to either `vitals` or `lab_results` based on
 * `Observation.category` — callers should dispatch on the returned
 * `kind` discriminant before persisting.
 */
/**
 * `lab_results` rows in CareBridge carry `patient_id` and `source_system`
 * columns, but the underlying fhir-gateway lab mapper omits both — the
 * import path attaches them at the writer layer. The Epic converter
 * attaches them here so callers can persist directly without a second
 * normalisation pass.
 */
export type EpicLabResultRow = MappedLabResultRow & {
  patient_id: string;
  source_system: typeof EPIC_SOURCE_SYSTEM_TAG;
};

export type EpicObservationConversion =
  | { kind: "vital"; row: MappedVitalRow }
  | { kind: "lab"; row: EpicLabResultRow }
  | { kind: "unmapped"; reason: string };

export function epicObservationToRow(
  resource: FhirResource,
  patientId: string,
): EpicObservationConversion {
  const inbound = resource as unknown as InboundObservation;
  const category: ObservationCategory | null =
    classifyObservationCategory(inbound);
  if (category === "vital-signs") {
    const row = mapFhirObservationToVitalRow(inbound, patientId);
    if (!row) return { kind: "unmapped", reason: "vital-signs not mappable" };
    return { kind: "vital", row: withEpicSource(row) };
  }
  if (category === "laboratory") {
    const row = mapFhirObservationToLabResultRow(inbound);
    if (!row) return { kind: "unmapped", reason: "laboratory not mappable" };
    return {
      kind: "lab",
      row: {
        ...row,
        patient_id: patientId,
        source_system: EPIC_SOURCE_SYSTEM_TAG,
      },
    };
  }
  return {
    kind: "unmapped",
    reason: `unsupported observation category: ${category ?? "missing"}`,
  };
}

/**
 * Convert an Epic FHIR Condition to a CareBridge `diagnoses`-row insert.
 * The underlying mapper does not emit `source_system`, so the Epic
 * converter adds it explicitly.
 */
export function epicConditionToRow(
  resource: FhirResource,
  patientId: string,
): EpicDiagnosisRow | null {
  const mapped = mapFhirConditionToRow(
    resource as unknown as InboundCondition,
    patientId,
  );
  if (!mapped) return null;
  return { ...mapped, source_system: EPIC_SOURCE_SYSTEM_TAG };
}

/**
 * Convert an Epic FHIR AllergyIntolerance to a CareBridge `allergies`-row
 * insert.
 */
export function epicAllergyToRow(
  resource: FhirResource,
  patientId: string,
): MappedAllergyRow | null {
  const mapped = mapFhirAllergyIntoleranceToRow(
    resource as unknown as InboundAllergyIntolerance,
    patientId,
  );
  if (!mapped) return null;
  return withEpicSource(mapped);
}
