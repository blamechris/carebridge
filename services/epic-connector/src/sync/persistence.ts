/**
 * Persistence layer for Epic-synced FHIR resources (#391, #1191, #1200, #1201).
 *
 * Each persistResource* function:
 *  1. Looks up the existing CareBridge row for the (Epic resource_type, resource_id)
 *     tuple via the `fhir_resources` mapping table.
 *  2. If the mapping miss, does a *clinical fingerprint* fallback lookup
 *     (#1191) — patient_id + a small handful of stable plaintext columns
 *     per resource type (MRN, start_time + encounter_type, ICD-10 +
 *     onset_date, RxNorm + started_at, LOINC + recorded_at, etc.).
 *  3. UPSERTs the target row (insert when no mapping or fingerprint
 *     exists; update when one does).
 *  4. UPSERTs the `fhir_resources` mapping row so the next sync pull can
 *     find the same internal row.
 *  5. Refuses to overwrite CareBridge-originated data on BOTH the
 *     Epic-id path (step 1) AND the fingerprint path (step 2). When the
 *     existing target row has `source_system != "epic"` (or null on a
 *     table that has the column — defensively treated as non-epic), the
 *     writer skips the UPDATE, still writes the `fhir_resources`
 *     mapping (so Epic and CareBridge IDs round-trip to the same row),
 *     and logs the attempt to `audit_log`:
 *       • Epic-id path     → action="update", success=false,
 *                            reason="source_system_conflict" (#1183)
 *       • Fingerprint path → action="epic_sync_source_conflict" (#1200)
 *     When the matched row IS Epic-originated (or pre-#1191 untagged),
 *     the writer merges normally and logs `epic_sync_dedup_match` so
 *     the HIPAA trail records the reconciliation explicitly.
 *  6. Detects identity ambiguity on the fingerprint path (#1201): when
 *     the matched internal row already has a `fhir_resources` mapping
 *     pointing at a DIFFERENT Epic FHIR id, the writer skips the merge
 *     entirely, falls through to a plain INSERT (a new internal row +
 *     a new mapping for the inbound Epic id), and writes ONE audit row
 *     with action="epic_sync_dedup_conflict" carrying both Epic ids.
 *     The check runs BEFORE the source_system guard (#1200) — once two
 *     Epic ids both point at one row we've lost the ability to safely
 *     round-trip either, regardless of data ownership.
 *
 * Independent of #1190 (which adds explicit `source_system` columns to
 * encounters/diagnoses/allergies). Fingerprint matching reads only
 * plaintext clinical fields that exist on main today, and the writer
 * remains correct with or without #1190.
 *
 * Idempotent by design: re-running the same FHIR resource is a no-op
 * after the first call other than refreshing `updated_at`. This lets
 * the BullMQ job runner retry freely on transient errors.
 */
import crypto from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  getDb,
  patients,
  medications,
  vitals,
  labPanels,
  labResults,
  diagnoses,
  allergies,
  encounters,
  fhirResources,
  auditLog,
  hmacForIndex,
} from "@carebridge/db-schema";
import {
  epicPatientToRow,
  epicMedicationRequestToRow,
  epicMedicationStatementToRow,
  epicObservationToRow,
  epicConditionToRow,
  epicAllergyToRow,
  epicEncounterToRow,
  EPIC_SOURCE_SYSTEM_TAG,
} from "../converters.js";
import type { FhirResource } from "../fhir-types.js";

const EPIC_SYNC_AUDIT_USER = "system:epic-sync";
const DEDUP_MATCH_ACTION = "epic_sync_dedup_match";
/**
 * Audit action emitted when the fingerprint-merge path (#1191) hits a
 * row whose `source_system` is anything other than "epic". Distinct
 * from `epic_sync_dedup_match` (a successful merge) and from the
 * Epic-id-path `action="update", success=false` row (a different code
 * path predating fingerprint dedup). See #1200.
 */
const SOURCE_CONFLICT_ACTION = "epic_sync_source_conflict";

/**
 * Audit action emitted when a fingerprint hit lands on an internal row
 * that already has a `fhir_resources` mapping pointing at a DIFFERENT
 * Epic FHIR id (#1201). Distinct from `epic_sync_dedup_match` (a clean
 * merge) and `epic_sync_source_conflict` (#1200 — the matched row is
 * CareBridge-originated). Identity-ambiguity case: either Epic re-issued
 * an ID for the same logical entity or two distinct Epic entities
 * collide on our fingerprint key. The writer falls through to a plain
 * INSERT, refusing to silently double-map two Epic ids to one row.
 */
const DEDUP_CONFLICT_ACTION = "epic_sync_dedup_conflict";

/**
 * Returns true when the fingerprint-matched row was originally written
 * by Epic and is therefore safe to overwrite with the latest Epic
 * payload. Null is treated as "not Epic": pre-#1190 rows on tables that
 * lacked the column default to null at read time, and the safer policy
 * is to skip the UPDATE and let manual reconciliation decide.
 */
function isEpicOwned(sourceSystem: string | null | undefined): boolean {
  return sourceSystem === EPIC_SOURCE_SYSTEM_TAG;
}

export interface PersistResult {
  /** Internal CareBridge row id, or null when the resource was unmappable. */
  internalId: string | null;
  /** Discriminator for downstream event emission. */
  kind:
    | "patient"
    | "medication"
    | "vital"
    | "lab"
    | "diagnosis"
    | "allergy"
    | "encounter"
    | "unmapped";
  /** True when the call inserted a new row; false when it updated. */
  inserted: boolean;
  /** Set when the call rejected an Epic update due to source_system mismatch. */
  conflict?: string;
}

interface MappingLookup {
  internalId: string | null;
  /** When set, an existing target row owns this resource with non-Epic source. */
  existingSourceSystem?: string | null;
}

async function findMapping(
  resourceType: string,
  fhirId: string,
): Promise<MappingLookup> {
  const db = getDb();
  const rows = await db
    .select()
    .from(fhirResources)
    .where(
      and(
        eq(fhirResources.resource_type, resourceType),
        eq(fhirResources.resource_id, fhirId),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return { internalId: null };
  return {
    internalId: existing.internal_record_id ?? null,
    existingSourceSystem: existing.source_system,
  };
}

async function upsertMapping(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  resource: unknown;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  // fhir_resources.id is a free-form PK in the existing schema; we
  // synthesise a deterministic id from (resource_type, fhir_id) so a
  // re-emit upserts the same mapping row rather than appending.
  const mappingId = `epic:${args.resourceType}:${args.fhirId}`;
  await db
    .insert(fhirResources)
    .values({
      id: mappingId,
      resource_type: args.resourceType,
      resource_id: args.fhirId,
      patient_id: args.patientId,
      resource: args.resource as object,
      source_system: EPIC_SOURCE_SYSTEM_TAG,
      internal_record_id: args.internalId,
      imported_at: now,
    })
    .onConflictDoUpdate({
      target: fhirResources.id,
      set: {
        resource: args.resource as object,
        internal_record_id: args.internalId,
        imported_at: now,
      },
    });
}

async function logSourceConflict(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  existingSourceSystem: string | null | undefined;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: EPIC_SYNC_AUDIT_USER,
    action: "update",
    resource_type: args.resourceType,
    resource_id: args.internalId,
    patient_id: args.patientId,
    success: false,
    details: JSON.stringify({
      reason: "source_system_conflict",
      attempted_source: EPIC_SOURCE_SYSTEM_TAG,
      existing_source: args.existingSourceSystem ?? null,
      epic_fhir_id: args.fhirId,
      resolution: "keep_carebridge_value",
    }),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log a cross-source dedup hit (#1191). Distinct from source-system
 * conflicts: a fingerprint match means the Epic resource is the same
 * logical entity as an existing CareBridge row, and we merged into it.
 * Recorded as success=true so the HIPAA audit trail shows the
 * reconciliation explicitly rather than as a failure.
 *
 * `overwrittenFields` (#1203) is set by callers that know exactly which
 * columns the UPDATE rewrote and what the prior values were. When non-
 * empty, the audit row's `details.overwritten_fields` carries
 * `{ field: priorValue, ... }` so a HIPAA reviewer can reconstruct the
 * clinician's pre-merge state. No-op merges (every inbound value equal
 * to the prior value) omit the key entirely — no audit weight on a
 * merge that didn't actually change anything.
 */
async function logDedupMatch(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  fingerprint: Record<string, unknown>;
  overwrittenFields?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const details: Record<string, unknown> = {
    reason: "fingerprint_match",
    attempted_source: EPIC_SOURCE_SYSTEM_TAG,
    epic_fhir_id: args.fhirId,
    fingerprint: args.fingerprint,
    resolution: "merge_into_existing_internal_row",
  };
  if (
    args.overwrittenFields &&
    Object.keys(args.overwrittenFields).length > 0
  ) {
    details.overwritten_fields = args.overwrittenFields;
  }
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: EPIC_SYNC_AUDIT_USER,
    action: DEDUP_MATCH_ACTION,
    resource_type: args.resourceType,
    resource_id: args.internalId,
    patient_id: args.patientId,
    success: true,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Look up a pre-existing Epic-id mapping that already points at the
 * given internal record id but with a DIFFERENT resource_id than the
 * inbound FHIR id (#1201). When this returns a row, the caller must
 * NOT merge into the fingerprint-matched internal row — two distinct
 * Epic ids would otherwise both round-trip to the same CareBridge
 * record with no signal to a reviewer. Caller falls through to a
 * plain INSERT and writes an `epic_sync_dedup_conflict` audit row.
 *
 * Returns null when there is no such conflicting mapping. A mapping
 * whose resource_id equals the inbound FHIR id is *not* a conflict —
 * it's the same logical Epic resource re-syncing.
 */
interface ConflictingMapping {
  existingEpicFhirId: string;
  internalRecordId: string;
}

async function findConflictingMapping(args: {
  resourceType: string;
  matchedInternalId: string;
  inboundFhirId: string;
}): Promise<ConflictingMapping | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(fhirResources)
    .where(
      and(
        eq(fhirResources.resource_type, args.resourceType),
        eq(fhirResources.internal_record_id, args.matchedInternalId),
        ne(fhirResources.resource_id, args.inboundFhirId),
      ),
    )
    .limit(1);
  // Defensive: Drizzle returns [] on no rows, but unit-test mocks that
  // under-queue can return undefined. Treat both as "no conflict".
  const existing = rows?.[0];
  if (!existing) return null;
  return {
    existingEpicFhirId: existing.resource_id,
    internalRecordId: existing.internal_record_id ?? args.matchedInternalId,
  };
}

/**
 * Log an Epic-id conflict on the fingerprint path (#1201). The matched
 * internal row already has a different Epic FHIR id mapped to it; the
 * caller has already fallen through to INSERT a fresh internal row and
 * its own mapping. This audit row preserves both Epic ids and the
 * fingerprint for manual reconciliation.
 */
async function logDedupConflict(args: {
  resourceType: string;
  newEpicFhirId: string;
  existingEpicFhirId: string;
  matchedInternalId: string;
  newInternalId: string;
  patientId: string | null;
  fingerprint: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: EPIC_SYNC_AUDIT_USER,
    action: DEDUP_CONFLICT_ACTION,
    resource_type: args.resourceType,
    // Tie the audit row to the NEWLY-inserted internal id — that's the
    // row this Epic id now owns. The pre-existing internal id surfaces
    // in `details.matched_internal_id` for the manual reviewer.
    resource_id: args.newInternalId,
    patient_id: args.patientId,
    success: false,
    details: JSON.stringify({
      reason: "epic_id_conflict_on_fingerprint_match",
      attempted_source: EPIC_SOURCE_SYSTEM_TAG,
      new_epic_fhir_id: args.newEpicFhirId,
      existing_epic_fhir_id: args.existingEpicFhirId,
      matched_internal_id: args.matchedInternalId,
      fingerprint: args.fingerprint,
      resolution: "insert_new_internal_row",
    }),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log a fingerprint-merge attempt that hit a CareBridge-originated row
 * (#1200). Recorded as success=false to flag the attempted overwrite,
 * but the `fhir_resources` mapping IS still written by the caller — the
 * Epic FHIR id and the CareBridge internal id refer to the same logical
 * entity, so future re-syncs need to land on this row (and trip the
 * same guard).
 */
async function logFingerprintSourceConflict(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  existingSourceSystem: string | null | undefined;
  fingerprint: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: EPIC_SYNC_AUDIT_USER,
    action: SOURCE_CONFLICT_ACTION,
    resource_type: args.resourceType,
    resource_id: args.internalId,
    patient_id: args.patientId,
    success: false,
    details: JSON.stringify({
      reason: "fingerprint_source_system_conflict",
      attempted_source: EPIC_SOURCE_SYSTEM_TAG,
      existing_source: args.existingSourceSystem ?? null,
      epic_fhir_id: args.fhirId,
      fingerprint: args.fingerprint,
      resolution: "keep_carebridge_value",
    }),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Look up an existing CareBridge row by clinical fingerprint. Returns
 * the matching row's `id` and (when the column exists on the table) its
 * `source_system` for downstream policy decisions.
 *
 * All fingerprint queries operate on plaintext-indexed columns only —
 * encrypted columns (allergen name, medication free-text name, lab
 * test_name) can't be equality-compared without HMAC sidebands that
 * don't exist on most tables today. When code values (RxNorm, LOINC,
 * ICD-10, SNOMED) are absent on the inbound Epic resource the lookup
 * returns null and the caller falls through to insert — better to
 * tolerate the occasional duplicate than to risk false-merges on a
 * dimensionally-weak fingerprint.
 */
interface FingerprintHit {
  internalId: string;
  sourceSystem: string | null;
  /**
   * Optional snapshot of the matched row's fields BEFORE a dedup-merge
   * UPDATE rewrites them (#1203). Populated only by finders whose caller
   * uses it for audit-payload provenance (currently allergies). Keep
   * the shape narrow per resource — only fields the matching writer's
   * UPDATE statement actually touches need to be carried, otherwise
   * we'd be paying for unrelated columns on every fingerprint lookup.
   */
  priorAllergyRow?: PriorAllergyRow;
}

/**
 * Subset of `allergies` columns captured before the dedup-merge UPDATE
 * so the audit payload can carry pre-update values. Exactly the columns
 * `persistAllergy`'s UPDATE statement rewrites today (#1203). When the
 * UPDATE widens to a new column, add the field here AND in
 * {@link computeAllergyOverwrittenFields} together — the diff is the
 * single source of truth for what gets snapshotted.
 */
interface PriorAllergyRow {
  allergen: string | null;
  severity: string | null;
  reaction: string | null;
}

async function findEncounterByFingerprint(args: {
  patientId: string;
  startTime: string;
  encounterType: string;
}): Promise<FingerprintHit | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(encounters)
    .where(
      and(
        eq(encounters.patient_id, args.patientId),
        eq(encounters.start_time, args.startTime),
        eq(encounters.encounter_type, args.encounterType),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem: hit.source_system ?? null,
  };
}

async function findDiagnosisByFingerprint(args: {
  patientId: string;
  icd10Code: string | null;
  snomedCode: string | null;
  onsetDate: string | null;
}): Promise<FingerprintHit | null> {
  // Need at least one code dimension to fingerprint safely.
  if (!args.icd10Code && !args.snomedCode) return null;
  const db = getDb();
  const codePredicate = args.icd10Code
    ? eq(diagnoses.icd10_code, args.icd10Code)
    : eq(diagnoses.snomed_code, args.snomedCode!);
  // onset_date is nullable on the table; only join it when both sides
  // carry a value, otherwise widen the fingerprint to patient+code so a
  // CareBridge row without an onset date can still be matched.
  const predicate = args.onsetDate
    ? and(
        eq(diagnoses.patient_id, args.patientId),
        codePredicate,
        eq(diagnoses.onset_date, args.onsetDate),
      )
    : and(eq(diagnoses.patient_id, args.patientId), codePredicate);
  const rows = await db.select().from(diagnoses).where(predicate).limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem: hit.source_system ?? null,
  };
}

async function findAllergyByFingerprint(args: {
  patientId: string;
  rxnormCode: string | null;
  snomedCode: string | null;
}): Promise<FingerprintHit | null> {
  if (!args.rxnormCode && !args.snomedCode) return null;
  const db = getDb();
  const codePredicate = args.rxnormCode
    ? eq(allergies.rxnorm_code, args.rxnormCode)
    : eq(allergies.snomed_code, args.snomedCode!);
  const rows = await db
    .select()
    .from(allergies)
    .where(and(eq(allergies.patient_id, args.patientId), codePredicate))
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem: hit.source_system ?? null,
    // #1203: snapshot the columns persistAllergy's UPDATE will rewrite.
    priorAllergyRow: {
      allergen: hit.allergen ?? null,
      severity: hit.severity ?? null,
      reaction: hit.reaction ?? null,
    },
  };
}

/**
 * Diff the inbound Epic row against the matched row's pre-update values
 * for the columns `persistAllergy`'s UPDATE rewrites (#1203). Returns a
 * map of `{ field: priorValue }` for every field whose new value differs
 * from the prior value. Empty when the merge is a no-op (every column
 * already matched), in which case the caller omits the audit payload
 * key entirely.
 *
 * Comparison is strict equality on plaintext values. `allergen` and
 * `reaction` are encrypted columns at rest but the persistence layer
 * sees plaintext on read/write, so this is a like-for-like compare.
 */
function computeAllergyOverwrittenFields(
  prior: PriorAllergyRow,
  incoming: { allergen: string; severity: string | null; reaction: string | null },
): Record<string, unknown> {
  const overwritten: Record<string, unknown> = {};
  if (prior.allergen !== incoming.allergen) overwritten.allergen = prior.allergen;
  if (prior.severity !== incoming.severity) overwritten.severity = prior.severity;
  if (prior.reaction !== incoming.reaction) overwritten.reaction = prior.reaction;
  return overwritten;
}

async function findMedicationByFingerprint(args: {
  patientId: string;
  rxnormCode: string | null;
  startedAt: string | null;
}): Promise<FingerprintHit | null> {
  if (!args.rxnormCode) return null;
  const db = getDb();
  const predicate = args.startedAt
    ? and(
        eq(medications.patient_id, args.patientId),
        eq(medications.rxnorm_code, args.rxnormCode),
        eq(medications.started_at, args.startedAt),
      )
    : and(
        eq(medications.patient_id, args.patientId),
        eq(medications.rxnorm_code, args.rxnormCode),
      );
  const rows = await db
    .select()
    .from(medications)
    .where(predicate)
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem: hit.source_system ?? null,
  };
}

async function findVitalByFingerprint(args: {
  patientId: string;
  loincCode: string | null;
  recordedAt: string;
}): Promise<FingerprintHit | null> {
  if (!args.loincCode) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(vitals)
    .where(
      and(
        eq(vitals.patient_id, args.patientId),
        eq(vitals.loinc_code, args.loincCode),
        eq(vitals.recorded_at, args.recordedAt),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem: hit.source_system ?? null,
  };
}

// #1202 — panel_name uses test_name for single-result Observations,
// so two distinct panels labelled differently for the same test collide.
async function findLabPanelByFingerprint(args: {
  patientId: string;
  panelName: string;
  collectedAt: string | null;
}): Promise<FingerprintHit | null> {
  const db = getDb();
  const predicate = args.collectedAt
    ? and(
        eq(labPanels.patient_id, args.patientId),
        eq(labPanels.panel_name, args.panelName),
        eq(labPanels.collected_at, args.collectedAt),
      )
    : and(
        eq(labPanels.patient_id, args.patientId),
        eq(labPanels.panel_name, args.panelName),
      );
  const rows = await db.select().from(labPanels).where(predicate).limit(1);
  const hit = rows[0];
  if (!hit) return null;
  return {
    internalId: hit.id,
    sourceSystem:
      (hit as { source_system?: string | null }).source_system ?? null,
  };
}

async function findPatientByFingerprint(args: {
  mrnHmac: string | null;
}): Promise<FingerprintHit | null> {
  if (!args.mrnHmac) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(patients)
    .where(eq(patients.mrn_hmac, args.mrnHmac))
    .limit(1);
  const hit = rows[0];
  if (!hit) return null;
  // patients has no source_system column — treat as internal.
  return {
    internalId: hit.id,
    sourceSystem: null,
  };
}

/**
 * Per-row write helpers: each calls findMapping → INSERT or UPDATE on
 * the target table → upsertMapping. The conflict check (source_system
 * != "epic") refuses to overwrite CareBridge-originated rows.
 */

export async function persistPatient(
  resource: FhirResource,
): Promise<PersistResult> {
  const row = epicPatientToRow(resource);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const mapping = await findMapping("Patient", fhirId);
  const db = getDb();
  const now = new Date().toISOString();

  if (mapping.internalId) {
    // Patient already imported — update only Epic-owned rows.
    // Patient identity is treated as Epic-owned when first imported
    // from Epic, so the conflict check is a belt-and-braces guard.
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Patient",
        fhirId,
        internalId: mapping.internalId,
        patientId: mapping.internalId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "patient",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(patients)
      .set({
        name: row.name,
        date_of_birth: row.date_of_birth,
        biological_sex: row.biological_sex,
        mrn: row.mrn ?? undefined,
        updated_at: now,
      })
      .where(eq(patients.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Patient",
      fhirId,
      internalId: mapping.internalId,
      patientId: mapping.internalId,
      resource,
    });
    return { internalId: mapping.internalId, kind: "patient", inserted: false };
  }

  // #1191 fingerprint fallback. The patients table already has a
  // unique constraint on mrn_hmac, so this lookup is also the safety
  // net for the unique-violation that would otherwise come up at INSERT
  // time. Reading mrn_hmac directly from the converter row would be
  // cleaner, but the existing MappedPatientRow shape stores the
  // plaintext MRN; we recompute the HMAC on the fly via a deterministic
  // helper at write time (hmacForIndex is invoked inside the encrypted
  // column adapter, so we surface the lookup via a select on the
  // hmac column populated by a prior write — see migration 0023).
  const mrnHmac = computeMrnHmacIfPresent(row.mrn ?? null);
  const fingerprintHit = await findPatientByFingerprint({ mrnHmac });
  const fingerprint = { mrn_hmac: mrnHmac };
  // #1201: identity-ambiguity check. Patient identity is a high-stakes
  // case — two Epic patient FHIR ids resolving to the same MRN HMAC
  // usually means an Epic-side merge / unmerge cycle. Treat as conflict.
  let conflictMapping: ConflictingMapping | null = null;
  if (fingerprintHit) {
    conflictMapping = await findConflictingMapping({
      resourceType: "Patient",
      matchedInternalId: fingerprintHit.internalId,
      inboundFhirId: fhirId,
    });
  }
  if (fingerprintHit && !conflictMapping) {
    await db
      .update(patients)
      .set({
        name: row.name,
        date_of_birth: row.date_of_birth,
        biological_sex: row.biological_sex,
        mrn: row.mrn ?? undefined,
        updated_at: now,
      })
      .where(eq(patients.id, fingerprintHit.internalId));
    await upsertMapping({
      resourceType: "Patient",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId: fingerprintHit.internalId,
      resource,
    });
    await logDedupMatch({
      resourceType: "Patient",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId: fingerprintHit.internalId,
      fingerprint,
    });
    return {
      internalId: fingerprintHit.internalId,
      kind: "patient",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(patients).values({
    id,
    mrn: row.mrn ?? undefined,
    name: row.name,
    date_of_birth: row.date_of_birth,
    biological_sex: row.biological_sex,
    created_at: now,
    updated_at: now,
  });
  await upsertMapping({
    resourceType: "Patient",
    fhirId,
    internalId: id,
    patientId: id,
    resource,
  });
  if (conflictMapping && fingerprintHit) {
    await logDedupConflict({
      resourceType: "Patient",
      newEpicFhirId: fhirId,
      existingEpicFhirId: conflictMapping.existingEpicFhirId,
      matchedInternalId: fingerprintHit.internalId,
      newInternalId: id,
      patientId: id,
      fingerprint,
    });
  }
  return { internalId: id, kind: "patient", inserted: true };
}

/**
 * Compute the deterministic MRN HMAC used by the `mrn_hmac` column.
 * When the HMAC helper is unavailable (test mocks, missing PHI_HMAC_KEY
 * in dev), returns null and the fingerprint lookup short-circuits,
 * leaving the mapping-only path intact.
 */
function computeMrnHmacIfPresent(mrn: string | null): string | null {
  if (!mrn || mrn.trim() === "") return null;
  try {
    return hmacForIndex(mrn);
  } catch {
    return null;
  }
}

export async function persistMedicationRequest(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const row = epicMedicationRequestToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };
  return persistMedicationRow(row, resource, patientId, "MedicationRequest");
}

export async function persistMedicationStatement(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const row = epicMedicationStatementToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };
  return persistMedicationRow(row, resource, patientId, "MedicationStatement");
}

async function persistMedicationRow(
  row: NonNullable<ReturnType<typeof epicMedicationRequestToRow>>,
  resource: FhirResource,
  patientId: string,
  resourceType: "MedicationRequest" | "MedicationStatement",
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const mapping = await findMapping(resourceType, fhirId);
  const db = getDb();
  const now = new Date().toISOString();

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType,
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "medication",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(medications)
      .set({
        name: row.name,
        dose_amount: row.dose_amount,
        dose_unit: row.dose_unit,
        route: row.route,
        frequency: row.frequency,
        status: row.status,
        rxnorm_code: row.rxnorm_code,
        max_doses_per_day: row.max_doses_per_day,
        updated_at: now,
      })
      .where(eq(medications.id, mapping.internalId));
    await upsertMapping({
      resourceType,
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "medication",
      inserted: false,
    };
  }

  // #1191 fingerprint fallback — patient_id + rxnorm_code + started_at.
  const fingerprintHit = await findMedicationByFingerprint({
    patientId,
    rxnormCode: row.rxnorm_code ?? null,
    startedAt: row.started_at ?? null,
  });
  const fingerprint = {
    patient_id: patientId,
    rxnorm_code: row.rxnorm_code,
    started_at: row.started_at,
  };
  // #1201: identity-ambiguity check (see persistEncounter for rationale).
  let conflictMapping: ConflictingMapping | null = null;
  if (fingerprintHit) {
    conflictMapping = await findConflictingMapping({
      resourceType,
      matchedInternalId: fingerprintHit.internalId,
      inboundFhirId: fhirId,
    });
  }
  if (fingerprintHit && !conflictMapping) {
    // #1200: source_system guard — see persistEncounter for rationale.
    if (!isEpicOwned(fingerprintHit.sourceSystem)) {
      await upsertMapping({
        resourceType,
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        resource,
      });
      await logFingerprintSourceConflict({
        resourceType,
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        existingSourceSystem: fingerprintHit.sourceSystem,
        fingerprint,
      });
      return {
        internalId: fingerprintHit.internalId,
        kind: "medication",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(medications)
      .set({
        name: row.name,
        dose_amount: row.dose_amount,
        dose_unit: row.dose_unit,
        route: row.route,
        frequency: row.frequency,
        status: row.status,
        rxnorm_code: row.rxnorm_code,
        max_doses_per_day: row.max_doses_per_day,
        updated_at: now,
      })
      .where(eq(medications.id, fingerprintHit.internalId));
    await upsertMapping({
      resourceType,
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      resource,
    });
    await logDedupMatch({
      resourceType,
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      fingerprint,
    });
    return {
      internalId: fingerprintHit.internalId,
      kind: "medication",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(medications).values({
    id,
    patient_id: patientId,
    name: row.name,
    dose_amount: row.dose_amount,
    dose_unit: row.dose_unit,
    route: row.route,
    frequency: row.frequency,
    status: row.status,
    rxnorm_code: row.rxnorm_code,
    max_doses_per_day: row.max_doses_per_day,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
    updated_at: now,
  });
  await upsertMapping({
    resourceType,
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  if (conflictMapping && fingerprintHit) {
    await logDedupConflict({
      resourceType,
      newEpicFhirId: fhirId,
      existingEpicFhirId: conflictMapping.existingEpicFhirId,
      matchedInternalId: fingerprintHit.internalId,
      newInternalId: id,
      patientId,
      fingerprint,
    });
  }
  return { internalId: id, kind: "medication", inserted: true };
}

export async function persistObservation(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const conversion = epicObservationToRow(resource, patientId);
  if (conversion.kind === "unmapped") {
    return { internalId: null, kind: "unmapped", inserted: false };
  }

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Observation", fhirId);

  if (conversion.kind === "vital") {
    if (mapping.internalId) {
      if (
        mapping.existingSourceSystem &&
        mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
      ) {
        await logSourceConflict({
          resourceType: "Observation",
          fhirId,
          internalId: mapping.internalId,
          patientId,
          existingSourceSystem: mapping.existingSourceSystem,
        });
        return {
          internalId: mapping.internalId,
          kind: "vital",
          inserted: false,
          conflict: "source_system_conflict",
        };
      }
      await db
        .update(vitals)
        .set({
          type: conversion.row.type,
          loinc_code: conversion.row.loinc_code,
          value_primary: conversion.row.value_primary,
          value_secondary: conversion.row.value_secondary,
          unit: conversion.row.unit,
          recorded_at: conversion.row.recorded_at,
        })
        .where(eq(vitals.id, mapping.internalId));
      await upsertMapping({
        resourceType: "Observation",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        resource,
      });
      return {
        internalId: mapping.internalId,
        kind: "vital",
        inserted: false,
      };
    }

    // #1191 fingerprint fallback — patient_id + loinc_code + recorded_at.
    const fingerprintHit = await findVitalByFingerprint({
      patientId,
      loincCode: conversion.row.loinc_code ?? null,
      recordedAt: conversion.row.recorded_at,
    });
    const fingerprint = {
      patient_id: patientId,
      loinc_code: conversion.row.loinc_code,
      recorded_at: conversion.row.recorded_at,
    };
    // #1201: identity-ambiguity check (see persistEncounter).
    let conflictMapping: ConflictingMapping | null = null;
    if (fingerprintHit) {
      conflictMapping = await findConflictingMapping({
        resourceType: "Observation",
        matchedInternalId: fingerprintHit.internalId,
        inboundFhirId: fhirId,
      });
    }
    if (fingerprintHit && !conflictMapping) {
      // #1200: source_system guard — see persistEncounter for rationale.
      if (!isEpicOwned(fingerprintHit.sourceSystem)) {
        await upsertMapping({
          resourceType: "Observation",
          fhirId,
          internalId: fingerprintHit.internalId,
          patientId,
          resource,
        });
        await logFingerprintSourceConflict({
          resourceType: "Observation",
          fhirId,
          internalId: fingerprintHit.internalId,
          patientId,
          existingSourceSystem: fingerprintHit.sourceSystem,
          fingerprint,
        });
        return {
          internalId: fingerprintHit.internalId,
          kind: "vital",
          inserted: false,
          conflict: "source_system_conflict",
        };
      }
      await db
        .update(vitals)
        .set({
          type: conversion.row.type,
          loinc_code: conversion.row.loinc_code,
          value_primary: conversion.row.value_primary,
          value_secondary: conversion.row.value_secondary,
          unit: conversion.row.unit,
          recorded_at: conversion.row.recorded_at,
        })
        .where(eq(vitals.id, fingerprintHit.internalId));
      await upsertMapping({
        resourceType: "Observation",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        resource,
      });
      await logDedupMatch({
        resourceType: "Observation",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        fingerprint,
      });
      return {
        internalId: fingerprintHit.internalId,
        kind: "vital",
        inserted: false,
      };
    }

    const id = crypto.randomUUID();
    await db.insert(vitals).values({
      id,
      patient_id: patientId,
      type: conversion.row.type,
      loinc_code: conversion.row.loinc_code,
      value_primary: conversion.row.value_primary,
      value_secondary: conversion.row.value_secondary,
      unit: conversion.row.unit,
      recorded_at: conversion.row.recorded_at,
      source_system: EPIC_SOURCE_SYSTEM_TAG,
      created_at: now,
    });
    await upsertMapping({
      resourceType: "Observation",
      fhirId,
      internalId: id,
      patientId,
      resource,
    });
    if (conflictMapping && fingerprintHit) {
      await logDedupConflict({
        resourceType: "Observation",
        newEpicFhirId: fhirId,
        existingEpicFhirId: conflictMapping.existingEpicFhirId,
        matchedInternalId: fingerprintHit.internalId,
        newInternalId: id,
        patientId,
        fingerprint,
      });
    }
    return { internalId: id, kind: "vital", inserted: true };
  }

  // Lab result — single-result panel synthesised for the Epic
  // resource. Multi-test panels arriving from Epic come in as a
  // DiagnosticReport (deferred to #391-followup) and are not handled
  // here yet. Panel-level fingerprint dedup (#1202) reuses an existing
  // lab_panels row when patient_id + panel_name + collected_at matches.
  if (mapping.internalId) {
    // Existing lab_results rows are leaves — conflict logic on the panel
    // level is out of scope for the first cut. Refresh the value in place.
    await db
      .update(labResults)
      .set({
        test_name: conversion.row.test_name,
        test_code: conversion.row.test_code,
        value: conversion.row.value,
        unit: conversion.row.unit,
        reference_low: conversion.row.reference_low,
        reference_high: conversion.row.reference_high,
        flag: conversion.row.flag,
      })
      .where(eq(labResults.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Observation",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return { internalId: mapping.internalId, kind: "lab", inserted: false };
  }

  // #1202 panel-level fingerprint fallback — patient_id + panel_name +
  // collected_at. Single-test Epic Observations synthesise a one-row
  // panel keyed by test_name, so repeated syncs of the same test reuse
  // the panel and attach the new result row to it.
  const panelFingerprintHit = await findLabPanelByFingerprint({
    patientId,
    panelName: conversion.row.test_name,
    collectedAt: conversion.row.recorded_at,
  });
  if (panelFingerprintHit) {
    // #1207 — store the newly-inserted lab_results.id (the leaf the
    // Epic Observation id round-trips to) in the fhir_resources
    // mapping, NOT the reused lab_panels.id. The round-2 update path
    // (see the `mapping.internalId` branch above) looks the mapping's
    // internalId up in labResults.id; pointing at a panel id would
    // silently match zero rows and drop Epic-side result changes.
    const resultId = crypto.randomUUID();
    await db.insert(labResults).values({
      id: resultId,
      panel_id: panelFingerprintHit.internalId,
      test_name: conversion.row.test_name,
      test_code: conversion.row.test_code,
      value: conversion.row.value,
      unit: conversion.row.unit,
      reference_low: conversion.row.reference_low,
      reference_high: conversion.row.reference_high,
      flag: conversion.row.flag,
      created_at: now,
    });
    await upsertMapping({
      resourceType: "Observation",
      fhirId,
      internalId: resultId,
      patientId,
      resource,
    });
    await logDedupMatch({
      resourceType: "Observation",
      fhirId,
      internalId: resultId,
      patientId,
      fingerprint: {
        patient_id: patientId,
        panel_name: conversion.row.test_name,
        collected_at: conversion.row.recorded_at,
      },
    });
    return {
      internalId: resultId,
      kind: "lab",
      inserted: false,
    };
  }

  const panelId = crypto.randomUUID();
  await db.insert(labPanels).values({
    id: panelId,
    patient_id: patientId,
    panel_name: conversion.row.test_name,
    collected_at: conversion.row.recorded_at,
    reported_at: conversion.row.recorded_at,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
  });
  const resultId = crypto.randomUUID();
  await db.insert(labResults).values({
    id: resultId,
    panel_id: panelId,
    test_name: conversion.row.test_name,
    test_code: conversion.row.test_code,
    value: conversion.row.value,
    unit: conversion.row.unit,
    reference_low: conversion.row.reference_low,
    reference_high: conversion.row.reference_high,
    flag: conversion.row.flag,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Observation",
    fhirId,
    internalId: resultId,
    patientId,
    resource,
  });
  return { internalId: resultId, kind: "lab", inserted: true };
}

export async function persistCondition(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicConditionToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Condition", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Condition",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "diagnosis",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(diagnoses)
      .set({
        description: row.description,
        icd10_code: row.icd10_code,
        snomed_code: row.snomed_code,
        status: row.status,
        onset_date: row.onset_date,
        resolved_date: row.resolved_date,
      })
      .where(eq(diagnoses.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Condition",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "diagnosis",
      inserted: false,
    };
  }

  // #1191 fingerprint fallback — patient_id + (icd10_code | snomed_code) + onset_date.
  const fingerprintHit = await findDiagnosisByFingerprint({
    patientId,
    icd10Code: row.icd10_code ?? null,
    snomedCode: row.snomed_code ?? null,
    onsetDate: row.onset_date ?? null,
  });
  const fingerprint = {
    patient_id: patientId,
    icd10_code: row.icd10_code,
    snomed_code: row.snomed_code,
    onset_date: row.onset_date,
  };
  // #1201: identity-ambiguity check (see persistEncounter).
  let conflictMapping: ConflictingMapping | null = null;
  if (fingerprintHit) {
    conflictMapping = await findConflictingMapping({
      resourceType: "Condition",
      matchedInternalId: fingerprintHit.internalId,
      inboundFhirId: fhirId,
    });
  }
  if (fingerprintHit && !conflictMapping) {
    // #1200: source_system guard — see persistEncounter for rationale.
    if (!isEpicOwned(fingerprintHit.sourceSystem)) {
      await upsertMapping({
        resourceType: "Condition",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        resource,
      });
      await logFingerprintSourceConflict({
        resourceType: "Condition",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        existingSourceSystem: fingerprintHit.sourceSystem,
        fingerprint,
      });
      return {
        internalId: fingerprintHit.internalId,
        kind: "diagnosis",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(diagnoses)
      .set({
        description: row.description,
        icd10_code: row.icd10_code,
        snomed_code: row.snomed_code,
        status: row.status,
        onset_date: row.onset_date,
        resolved_date: row.resolved_date,
      })
      .where(eq(diagnoses.id, fingerprintHit.internalId));
    await upsertMapping({
      resourceType: "Condition",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      resource,
    });
    await logDedupMatch({
      resourceType: "Condition",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      fingerprint,
    });
    return {
      internalId: fingerprintHit.internalId,
      kind: "diagnosis",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(diagnoses).values({
    id,
    patient_id: patientId,
    description: row.description,
    icd10_code: row.icd10_code,
    snomed_code: row.snomed_code,
    status: row.status,
    onset_date: row.onset_date,
    resolved_date: row.resolved_date,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Condition",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  if (conflictMapping && fingerprintHit) {
    await logDedupConflict({
      resourceType: "Condition",
      newEpicFhirId: fhirId,
      existingEpicFhirId: conflictMapping.existingEpicFhirId,
      matchedInternalId: fingerprintHit.internalId,
      newInternalId: id,
      patientId,
      fingerprint,
    });
  }
  return { internalId: id, kind: "diagnosis", inserted: true };
}

export async function persistAllergy(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicAllergyToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("AllergyIntolerance", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "AllergyIntolerance",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "allergy",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(allergies)
      .set({
        allergen: row.allergen,
        severity: row.severity,
        reaction: row.reaction,
      })
      .where(eq(allergies.id, mapping.internalId));
    await upsertMapping({
      resourceType: "AllergyIntolerance",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "allergy",
      inserted: false,
    };
  }

  // #1191 fingerprint fallback — patient_id + (rxnorm | snomed) code.
  // No timestamp dimension on allergies (allergens are typically
  // open-ended), and the free-text allergen column is encrypted, so we
  // rely on the coded substance for a safe match.
  const fingerprintHit = await findAllergyByFingerprint({
    patientId,
    rxnormCode: row.rxnorm_code ?? null,
    snomedCode: row.snomed_code ?? null,
  });
  const fingerprint = {
    patient_id: patientId,
    rxnorm_code: row.rxnorm_code,
    snomed_code: row.snomed_code,
  };
  // #1201: identity-ambiguity check (see persistEncounter).
  let conflictMapping: ConflictingMapping | null = null;
  if (fingerprintHit) {
    conflictMapping = await findConflictingMapping({
      resourceType: "AllergyIntolerance",
      matchedInternalId: fingerprintHit.internalId,
      inboundFhirId: fhirId,
    });
  }
  if (fingerprintHit && !conflictMapping) {
    // #1200: source_system guard — see persistEncounter for rationale.
    if (!isEpicOwned(fingerprintHit.sourceSystem)) {
      await upsertMapping({
        resourceType: "AllergyIntolerance",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        resource,
      });
      await logFingerprintSourceConflict({
        resourceType: "AllergyIntolerance",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        existingSourceSystem: fingerprintHit.sourceSystem,
        fingerprint,
      });
      return {
        internalId: fingerprintHit.internalId,
        kind: "allergy",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    // #1203: snapshot the prior values BEFORE the UPDATE so we can carry
    // them on the audit row when Epic overwrote a clinician-meaningful
    // field. `priorAllergyRow` is captured by findAllergyByFingerprint
    // and mirrors exactly the columns this UPDATE rewrites.
    const overwrittenFields = fingerprintHit.priorAllergyRow
      ? computeAllergyOverwrittenFields(fingerprintHit.priorAllergyRow, {
          allergen: row.allergen,
          severity: row.severity,
          reaction: row.reaction,
        })
      : {};
    await db
      .update(allergies)
      .set({
        allergen: row.allergen,
        severity: row.severity,
        reaction: row.reaction,
      })
      .where(eq(allergies.id, fingerprintHit.internalId));
    await upsertMapping({
      resourceType: "AllergyIntolerance",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      resource,
    });
    await logDedupMatch({
      resourceType: "AllergyIntolerance",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      fingerprint,
      overwrittenFields,
    });
    return {
      internalId: fingerprintHit.internalId,
      kind: "allergy",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(allergies).values({
    id,
    patient_id: patientId,
    allergen: row.allergen,
    severity: row.severity,
    reaction: row.reaction,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "AllergyIntolerance",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  if (conflictMapping && fingerprintHit) {
    await logDedupConflict({
      resourceType: "AllergyIntolerance",
      newEpicFhirId: fhirId,
      existingEpicFhirId: conflictMapping.existingEpicFhirId,
      matchedInternalId: fingerprintHit.internalId,
      newInternalId: id,
      patientId,
      fingerprint,
    });
  }
  return { internalId: id, kind: "allergy", inserted: true };
}

/**
 * Persist an Epic FHIR Encounter to the `encounters` table (#1181).
 *
 * Closes the last gap of #390 — the FHIR client has searchEncounters and
 * #1181 adds the converter + this writer + sync-worker fan-out. The
 * `encounters` table now carries a `source_system` column (#1190) which
 * this writer stamps with EPIC_SOURCE_SYSTEM_TAG on insert so Epic-
 * imported rows are distinguishable at the row level without a JOIN to
 * `fhir_resources`. The Epic CSN still round-trips through `fhir_resources`
 * (a dedicated `epic_encounter_id` column is out of scope here).
 *
 * #1191 adds a fingerprint fallback so a CareBridge-originated encounter
 * (created manually before Epic sync was wired) doesn't get duplicated
 * when Epic later syncs the same visit.
 */
export async function persistEncounter(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicEncounterToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Encounter", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Encounter",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "encounter",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(encounters)
      .set({
        encounter_type: row.encounter_type,
        status: row.status,
        start_time: row.start_time,
        end_time: row.end_time,
        location: row.location,
        reason: row.reason,
      })
      .where(eq(encounters.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Encounter",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "encounter",
      inserted: false,
    };
  }

  // #1191 fingerprint fallback — patient_id + start_time + encounter_type.
  const fingerprintHit = await findEncounterByFingerprint({
    patientId,
    startTime: row.start_time,
    encounterType: row.encounter_type,
  });
  const fingerprint = {
    patient_id: patientId,
    start_time: row.start_time,
    encounter_type: row.encounter_type,
  };
  // #1201: identity-ambiguity check. When the matched internal row
  // already has a different Epic FHIR id mapped to it, fall through to
  // a plain INSERT below and emit `epic_sync_dedup_conflict`. The check
  // runs BEFORE the #1200 source_system guard because once two Epic ids
  // both point at one row we've lost the ability to safely round-trip
  // either, regardless of data ownership.
  let conflictMapping: ConflictingMapping | null = null;
  if (fingerprintHit) {
    conflictMapping = await findConflictingMapping({
      resourceType: "Encounter",
      matchedInternalId: fingerprintHit.internalId,
      inboundFhirId: fhirId,
    });
  }
  if (fingerprintHit && !conflictMapping) {
    // #1200: guard the fingerprint-merge UPDATE on source_system. If the
    // matched row is CareBridge-originated, write the mapping so Epic IDs
    // still round-trip, but DO NOT overwrite the clinician's data.
    if (!isEpicOwned(fingerprintHit.sourceSystem)) {
      await upsertMapping({
        resourceType: "Encounter",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        resource,
      });
      await logFingerprintSourceConflict({
        resourceType: "Encounter",
        fhirId,
        internalId: fingerprintHit.internalId,
        patientId,
        existingSourceSystem: fingerprintHit.sourceSystem,
        fingerprint,
      });
      return {
        internalId: fingerprintHit.internalId,
        kind: "encounter",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(encounters)
      .set({
        encounter_type: row.encounter_type,
        status: row.status,
        start_time: row.start_time,
        end_time: row.end_time,
        location: row.location,
        reason: row.reason,
      })
      .where(eq(encounters.id, fingerprintHit.internalId));
    await upsertMapping({
      resourceType: "Encounter",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      resource,
    });
    await logDedupMatch({
      resourceType: "Encounter",
      fhirId,
      internalId: fingerprintHit.internalId,
      patientId,
      fingerprint,
    });
    return {
      internalId: fingerprintHit.internalId,
      kind: "encounter",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(encounters).values({
    id,
    patient_id: patientId,
    encounter_type: row.encounter_type,
    status: row.status,
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    reason: row.reason,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Encounter",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  if (conflictMapping && fingerprintHit) {
    await logDedupConflict({
      resourceType: "Encounter",
      newEpicFhirId: fhirId,
      existingEpicFhirId: conflictMapping.existingEpicFhirId,
      matchedInternalId: fingerprintHit.internalId,
      newInternalId: id,
      patientId,
      fingerprint,
    });
  }
  return { internalId: id, kind: "encounter", inserted: true };
}
