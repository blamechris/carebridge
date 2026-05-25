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

// ── Encounter (#1181 — last gap of #390) ────────────────────────────

/**
 * FHIR Encounter.status codeset (R4). Any value outside this set is
 * rewritten to `"unknown"` so a future Epic schema drift can't sneak a
 * surprise value into the persisted `encounters.status` column —
 * downstream clinical filters / dashboards assume the FHIR codeset.
 */
const FHIR_ENCOUNTER_STATUSES = new Set<string>([
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

/**
 * Mapped row shape returned by {@link epicEncounterToRow}.
 *
 * Mirrors the `encounters` table columns (id is generated by the
 * persistence layer; created_at is wall-clock at insert time). Two
 * fields the table doesn't have today still ride along on the row:
 *
 *  - `epic_encounter_id` — the Epic CSN / FHIR identifier. The
 *    fhir_resources mapping table stores the FHIR resource.id directly,
 *    so the CSN doesn't need its own column on `encounters` today; we
 *    surface it on the row so the persistence layer / future migration
 *    can pick it up without re-parsing.
 *  - `source_system` — mirrors the convention used by
 *    {@link epicConditionToRow}. The `encounters` table doesn't carry
 *    this column today either; the converter still attaches it so
 *    callers can distinguish Epic-imported rows downstream without a
 *    JOIN to `epic_sync_state`, and a follow-up migration can lift
 *    the field onto the table without changing the converter.
 *
 * `provider_id` is deliberately omitted: FHIR Encounter.participant
 * carries a Practitioner reference, but mapping FHIR Practitioner refs
 * to internal `users.id` requires a separate practitioner-sync flow
 * (out of scope for #1181). Future work can extend this row with a
 * resolved provider id when that mapping table lands.
 */
export interface EpicEncounterRow {
  patient_id: string;
  encounter_type: string;
  status: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  reason: string | null;
  /** Epic CSN (Contact Serial Number) — the canonical official identifier. */
  epic_encounter_id: string | null;
  source_system: typeof EPIC_SOURCE_SYSTEM_TAG;
}

interface EncounterIdentifier {
  use?: string;
  system?: string;
  value?: string;
}

interface EncounterCoding {
  system?: string;
  code?: string;
  display?: string;
}

interface EncounterCodeableConcept {
  text?: string;
  coding?: EncounterCoding[];
}

interface EncounterPeriod {
  start?: string;
  end?: string;
}

interface EncounterReference {
  reference?: string;
  display?: string;
}

interface EncounterLocationEntry {
  location?: EncounterReference;
}

interface EncounterParticipantEntry {
  individual?: EncounterReference;
}

interface InboundEncounter {
  resourceType: "Encounter";
  id?: string;
  identifier?: EncounterIdentifier[];
  status?: string;
  class?: EncounterCoding;
  subject?: EncounterReference;
  period?: EncounterPeriod;
  reasonCode?: EncounterCodeableConcept[];
  location?: EncounterLocationEntry[];
  participant?: EncounterParticipantEntry[];
}

/**
 * Pick the canonical Epic encounter identifier. Order of preference:
 *  1. The first `identifier[]` entry with `use === "official"` (Epic CSN).
 *  2. The first `identifier[]` entry of any use (graceful fallback so
 *     non-Epic FHIR servers that don't tag CSN as official still surface
 *     a stable id).
 *
 * Returns `null` when no identifier with a non-empty `value` is present.
 */
function pickEncounterIdentifier(
  identifiers: EncounterIdentifier[] | undefined,
): string | null {
  if (!identifiers || identifiers.length === 0) return null;
  for (const id of identifiers) {
    if (id.use === "official" && id.value && id.value.trim() !== "") {
      return id.value.trim();
    }
  }
  for (const id of identifiers) {
    if (id.value && id.value.trim() !== "") return id.value.trim();
  }
  return null;
}

/** Pick reason text from `reasonCode[0]`: `.text` first, then first display. */
function pickEncounterReason(
  reasonCode: EncounterCodeableConcept[] | undefined,
): string | null {
  if (!reasonCode || reasonCode.length === 0) return null;
  const first = reasonCode[0];
  if (!first) return null;
  if (first.text && first.text.trim() !== "") return first.text.trim();
  for (const c of first.coding ?? []) {
    if (c.display && c.display.trim() !== "") return c.display.trim();
  }
  return null;
}

/**
 * Convert an Epic FHIR Encounter to a CareBridge `encounters`-row insert.
 *
 * Returns `null` for unmappable resources:
 *  - missing `subject` (cannot link to a patient row)
 *  - missing `status` (FHIR R4 marks status as required — refuse to import
 *    a structurally broken payload rather than guess)
 *  - missing `period.start` (the encounters table requires `start_time`)
 *
 * Non-FHIR `status` values are coerced to `"unknown"` so downstream
 * filters assume only the documented codeset.
 *
 * Last gap of #390 — pairs with `EpicFhirClient.searchEncounters`.
 */
export function epicEncounterToRow(
  resource: FhirResource,
  patientId: string,
): EpicEncounterRow | null {
  const inbound = resource as unknown as InboundEncounter;

  // Required: subject reference. Matches the per-row convention used by
  // the other Epic converters where a missing-subject payload is dropped
  // (the persistence layer can't link the row without a patient_id).
  if (!inbound.subject || !inbound.subject.reference) return null;

  // Required: status. FHIR R4 marks Encounter.status as required — a
  // missing value is a structurally broken payload, not an unknown one.
  const rawStatus = inbound.status;
  if (!rawStatus || rawStatus.trim() === "") return null;

  // Required: period.start. The `encounters.start_time` column is notNull.
  const periodStart = inbound.period?.start;
  if (!periodStart || periodStart.trim() === "") return null;

  // Coerce non-FHIR status codes to "unknown" — preserves the codeset
  // contract that downstream filters (clinician portal status pills,
  // encounters-list dashboards) rely on.
  const status = FHIR_ENCOUNTER_STATUSES.has(rawStatus) ? rawStatus : "unknown";

  // class.code → encounter_type. FHIR marks class as required, but Epic
  // sometimes returns it empty for stub/placeholder encounters; fall
  // back to "unknown" rather than refuse to import — class is not a
  // clinical safety field.
  const encounterType =
    inbound.class?.code && inbound.class.code.trim() !== ""
      ? inbound.class.code
      : "unknown";

  const epicEncounterId = pickEncounterIdentifier(inbound.identifier);
  const reason = pickEncounterReason(inbound.reasonCode);
  const locationDisplay =
    inbound.location?.[0]?.location?.display?.trim() || null;

  return {
    patient_id: patientId,
    encounter_type: encounterType,
    status,
    start_time: periodStart,
    end_time:
      inbound.period?.end && inbound.period.end.trim() !== ""
        ? inbound.period.end
        : null,
    location: locationDisplay,
    reason,
    epic_encounter_id: epicEncounterId,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
  };
}
