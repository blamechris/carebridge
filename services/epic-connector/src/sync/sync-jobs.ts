/**
 * Epic sync job runners (#391).
 *
 * Pure orchestration functions — they take their dependencies
 * (FHIR client, persistence helpers, emit) as arguments so the BullMQ
 * worker can wire production dependencies while tests can inject mocks
 * without touching Redis or Postgres.
 *
 * Job types:
 *  - full-sync           — pull every resource type for a patient with
 *                          no `_lastUpdated` watermark. Used for first
 *                          import and "refresh everything" admin ops.
 *  - incremental-sync    — pull resources updated since the watermark
 *                          stored on `epic_sync_state`. Used for
 *                          background-scheduled syncs.
 *  - single-resource-sync — refresh one resource type for one patient.
 *                          Used by the tRPC trigger endpoint and by
 *                          the medication reconciliation flow.
 *
 * After each pull, every imported row emits a ClinicalEvent on the
 * `clinical-events` BullMQ queue with `source_system: "epic"` in the
 * event metadata. The existing ai-oversight review worker picks them
 * up unchanged — the AI safety rules fire on Epic-sourced data the
 * same way they fire on internally-recorded data.
 */
import crypto from "node:crypto";
import { createLogger } from "@carebridge/logger";
import type {
  ClinicalEvent,
  ClinicalEventType,
} from "@carebridge/shared-types";
import {
  EpicFhirClient,
  EpicFhirError,
  type EpicResourceType,
} from "../fhir-client.js";
import { EPIC_SOURCE_SYSTEM_TAG } from "../converters.js";
import {
  persistAllergy,
  persistCondition,
  persistMedicationRequest,
  persistObservation,
  persistPatient,
  type PersistResult,
} from "./persistence.js";
import {
  getSyncState,
  markFailed,
  markOk,
  markRunning,
} from "./sync-state-repo.js";
import {
  getObservationCategories,
  getMedicationRequestStatuses,
} from "./fanout-config.js";
import { EPIC_ERROR_CODES } from "../epic-error-codes.js";
import type { FhirResource } from "../fhir-types.js";

const log = createLogger("epic-sync-jobs");

export type SyncResourceType = Exclude<EpicResourceType, "Encounter">;

/**
 * Resource types this PR ships sync support for. Encounter persistence
 * is deferred to a follow-up — there's no inbound encounter mapper in
 * fhir-gateway yet, and the `encounters` table writes need their own
 * idempotency story (Epic CSN ↔ internal id).
 */
export const SUPPORTED_RESOURCE_TYPES: SyncResourceType[] = [
  "Patient",
  "Observation",
  "Condition",
  "MedicationRequest",
  "AllergyIntolerance",
];

export type EmitFn = (event: ClinicalEvent) => Promise<void>;

export interface SyncJobDeps {
  client: EpicFhirClient;
  emit: EmitFn;
}

/**
 * Sub-resource fetch that Epic rejected as unauthorized for the
 * registered scopes. Recorded on the SyncResult so admin tooling can
 * distinguish "scope registered but no data" from "scope not registered
 * — Epic refused to even run the search."
 *
 * `filter` carries the search params we sent EXCLUDING the patient id
 * (PHI hygiene — Epic FHIR ids aren't strict HIPAA PHI but treating
 * them conservatively is the safer default for surfacing this field
 * via tRPC to the clinician portal).
 */
export interface SkippedSubResource {
  resource_type: SyncResourceType;
  filter: Record<string, string>;
  reason: "unauthorized";
}

export interface SyncResult {
  patient_id: string;
  resource_type: SyncResourceType;
  imported: number;
  updated: number;
  conflicts: number;
  errors: string[];
  /** Sub-resource searches Epic refused (scope mismatch); not a sync failure. */
  skipped: SkippedSubResource[];
}

/**
 * Full-sync: pull every supported resource type for the given patient
 * with no incremental watermark. Used for first import.
 */
export async function runFullSync(
  args: { patientId: string; epicPatientFhirId?: string },
  deps: SyncJobDeps,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const resourceType of SUPPORTED_RESOURCE_TYPES) {
    results.push(
      await syncResourceType(
        {
          patientId: args.patientId,
          epicPatientFhirId: args.epicPatientFhirId,
          resourceType,
          watermark: null,
        },
        deps,
      ),
    );
  }
  return results;
}

/**
 * Incremental sync: pull resources updated since the watermark stored
 * on `epic_sync_state` for each (patient, resource_type) tuple.
 */
export async function runIncrementalSync(
  args: { patientId: string; epicPatientFhirId?: string },
  deps: SyncJobDeps,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const resourceType of SUPPORTED_RESOURCE_TYPES) {
    const state = await getSyncState(args.patientId, resourceType);
    results.push(
      await syncResourceType(
        {
          patientId: args.patientId,
          epicPatientFhirId: args.epicPatientFhirId,
          resourceType,
          watermark: state?.last_fhir_lastupdated ?? null,
        },
        deps,
      ),
    );
  }
  return results;
}

/**
 * Refresh a single resource type for a single patient.
 */
export async function runSingleResourceSync(
  args: {
    patientId: string;
    epicPatientFhirId?: string;
    resourceType: SyncResourceType;
    /** When set, use as the `_lastUpdated=gt<watermark>` filter. */
    watermark?: string | null;
  },
  deps: SyncJobDeps,
): Promise<SyncResult> {
  return syncResourceType(
    {
      patientId: args.patientId,
      epicPatientFhirId: args.epicPatientFhirId,
      resourceType: args.resourceType,
      watermark: args.watermark ?? null,
    },
    deps,
  );
}

interface SyncOneArgs {
  patientId: string;
  epicPatientFhirId?: string;
  resourceType: SyncResourceType;
  watermark: string | null;
}

async function syncResourceType(
  args: SyncOneArgs,
  deps: SyncJobDeps,
): Promise<SyncResult> {
  await markRunning(args.patientId, args.resourceType);

  const result: SyncResult = {
    patient_id: args.patientId,
    resource_type: args.resourceType,
    imported: 0,
    updated: 0,
    conflicts: 0,
    errors: [],
    skipped: [],
  };
  let highWatermark: string | null = args.watermark;

  try {
    // fetchResources pushes into result.skipped as it goes, so a
    // sibling fan-out throw mid-way (#1108) doesn't drop the partial
    // skipped collection — the catch block below persists what was
    // captured before the failure.
    const resources = await fetchResources(args, deps.client, result.skipped);

    for (const resource of resources) {
      try {
        const persisted = await persistOne(
          resource,
          args.resourceType,
          args.patientId,
        );
        if (persisted.kind === "unmapped") continue;

        if (persisted.conflict) {
          result.conflicts++;
        } else if (persisted.inserted) {
          result.imported++;
        } else {
          result.updated++;
        }

        if (!persisted.conflict && persisted.internalId) {
          await deps.emit(
            buildClinicalEvent({
              persisted,
              patientId: args.patientId,
              resource,
            }),
          );
        }

        const lastUpdated = (
          resource.meta as { lastUpdated?: string } | undefined
        )?.lastUpdated;
        if (lastUpdated && (!highWatermark || lastUpdated > highWatermark)) {
          highWatermark = lastUpdated;
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        log.error("Epic sync — per-resource failure", {
          patientId: args.patientId,
          resourceType: args.resourceType,
          fhirId: resource.id,
          error: message,
        });
        result.errors.push(message);
      }
    }

    await markOk({
      patientId: args.patientId,
      resourceType: args.resourceType,
      highWatermark,
      importedCount: result.imported,
      // Persist sub-resources Epic refused so the clinician portal can
      // distinguish "no data because patient has none" from "no data
      // because scope X wasn't registered" (#1097).
      skipped: result.skipped.map(({ filter, reason }) => ({ filter, reason })),
    });
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err);
    // #1124: when Epic returns the structured "required element missing"
    // code (59108), prefix the persisted error with the missing-element
    // diagnostic so the failed row in epic_sync_state names the field
    // (not just a generic 400 message). Helps the operator/dev fix the
    // upstream request-shape bug without spelunking through job logs.
    const missingRequiredElement = isMissingRequiredElementError(err);
    const message = missingRequiredElement
      ? `Epic required element missing: ${describeMissingElement(err)} — ${baseMessage}`
      : baseMessage;
    log.error("Epic sync — resource-type failure", {
      patientId: args.patientId,
      resourceType: args.resourceType,
      error: message,
      missingRequiredElement,
    });
    await markFailed({
      patientId: args.patientId,
      resourceType: args.resourceType,
      errorMessage: message,
      // Persist whatever soft-skips were collected before the throw
      // (#1108) so the auth-scope signal survives a partial-failure
      // sync and is visible in the epic_sync_state row alongside the
      // error status.
      skipped: result.skipped.map(({ filter, reason }) => ({ filter, reason })),
    });
    result.errors.push(message);
  }

  return result;
}

/**
 * Epic's R4 endpoint rejects `Observation?patient=X` without a `category`
 * or `code` filter (400 with "Must have either code or category"). We
 * fan out across the two categories the persistence layer cares about
 * — vital-signs lands in `vitals`, laboratory lands in `lab_results`
 * via observation-mapper.ts. Other categories (social-history, exam,
 * etc.) aren't mapped to internal tables today, so omitting them isn't
 * a data loss.
 *
 * Individual categories may 400 with "not authorized for this sub-resource"
 * if the registered app doesn't carry that category's scope — see
 * {@link isUnauthorizedSubResourceError}. Such failures are swallowed
 * per category so a sync registered with only one of the two categories
 * still imports what it's authorized for.
 *
 * The default set + status are overridable per deployment via env
 * (#1098) — see {@link getObservationCategories} and
 * {@link getMedicationRequestStatuses}.
 *
 * MedicationRequest also fans out per `status` (#1114) — same shape
 * as the Observation path. Default is a single-element `["active"]`
 * so the pre-#1114 behavior is preserved when env is unset.
 */

/**
 * Detect Epic's "not authorized for this sub-resource" 400 response so the
 * fan-out can skip categories the registered app doesn't carry the scope
 * for, while still surfacing genuine request-shape bugs.
 *
 * Preferred: structured check on the parsed OperationOutcome's coding
 * (`details.coding[].code === "59022"`) — proper FHIR-spec match that
 * survives Epic rewording the human text. After #1102 the literal lives
 * in {@link EPIC_ERROR_CODES.UNAUTHORIZED_SUB_RESOURCE}.
 *
 * Fallback: substring match on `"authorized sub-resource"` in the Error
 * message — covers cases where Epic returns a non-OperationOutcome body
 * (HTML 502 from a fronting proxy, plain text from an edge layer) but
 * the substring still appears verbatim. We deliberately use the more
 * specific phrase here — the looser "Combination of parameters is not
 * valid" prefix also fires for genuine request-shape errors (e.g. 59108
 * "missing required element") and MUST NOT be swallowed.
 */
function isUnauthorizedSubResourceError(err: unknown): boolean {
  if (
    err instanceof EpicFhirError &&
    err.hasIssueCode(EPIC_ERROR_CODES.UNAUTHORIZED_SUB_RESOURCE)
  ) {
    return true;
  }
  if (err instanceof Error && err.message.includes("authorized sub-resource")) {
    return true;
  }
  return false;
}

/**
 * Detect Epic's "A required element is missing" 400 (#1124). Distinct
 * from the unauthorized-sub-resource code in policy: 59022 → soft-skip
 * (registered app lacks scope), 59108 → SURFACE (request shape is
 * wrong, almost always a code bug).
 *
 * The discrimination is structural — pure FHIR-spec match on the
 * coding — and only fires on a structurally trusted OperationOutcome
 * (see `tryParseOperationOutcome` for the gate). No substring fallback
 * because 59108 indicates a code bug that we WANT to surface as a
 * loud failure rather than rescue with a fragile heuristic.
 */
export function isMissingRequiredElementError(err: unknown): boolean {
  return (
    err instanceof EpicFhirError &&
    err.hasIssueCode(EPIC_ERROR_CODES.MISSING_REQUIRED_ELEMENT)
  );
}

/**
 * Extract the missing-element diagnostic from an Epic 59108
 * OperationOutcome so the error message names the field — turns a
 * generic "A required element is missing" into actionable feedback
 * ("Required element missing: MedicationRequest.intent").
 */
export function describeMissingElement(err: unknown): string {
  if (!(err instanceof EpicFhirError) || !err.operationOutcome) {
    return "missing element (no diagnostics)";
  }
  const issue = err.operationOutcome.issue?.[0];
  return issue?.diagnostics ?? issue?.details?.text ?? "missing element (no diagnostics)";
}

/**
 * Strip undefined values, the `patient` PHI field, and FHIR control
 * params (`_lastUpdated`, etc.) for safe external surfacing.
 *
 * Control params (underscore-prefixed) are run-specific watermarks
 * that would make `skipped_sub_resources` high-cardinality across
 * incremental syncs — defeating the cross-patient aggregation signal
 * the column is meant to provide.
 */
function sanitizeFilterForReport(
  params: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "patient") continue;
    if (k.startsWith("_")) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

type SearchOutcome =
  | { kind: "resources"; resources: FhirResource[] }
  | { kind: "skipped"; entry: SkippedSubResource };

async function collectSearchOrSkipUnauthorized(
  client: EpicFhirClient,
  resourceType: SyncResourceType,
  params: Record<string, string | undefined>,
): Promise<SearchOutcome> {
  const out: FhirResource[] = [];
  try {
    for await (const r of client.searchAll(resourceType, params)) {
      out.push(r);
    }
    return { kind: "resources", resources: out };
  } catch (err) {
    if (isUnauthorizedSubResourceError(err)) {
      const filter = sanitizeFilterForReport(params);
      log.warn(
        "Epic sync — skipping unauthorized sub-resource (registered scopes don't cover this filter)",
        { resourceType, params: filter },
      );
      return {
        kind: "skipped",
        entry: { resource_type: resourceType, filter, reason: "unauthorized" },
      };
    }
    throw err;
  }
}

/**
 * Fetch the FHIR resources for one (patient, resource_type) pair.
 *
 * `skippedOut` is mutated as soft-skips are collected (#1108) — pushing
 * to a caller-owned array means partial collection survives a throw
 * partway through the fan-out, so a sibling fan-out call that fails
 * with a genuine error (ECONNREFUSED, 500, etc.) doesn't discard the
 * earlier auth-scope signals. The outer try/catch in
 * `syncResourceType` reads from the same array to persist whatever
 * was collected before the failure.
 */
async function fetchResources(
  args: SyncOneArgs,
  client: EpicFhirClient,
  skippedOut: SkippedSubResource[],
): Promise<FhirResource[]> {
  if (args.resourceType === "Patient") {
    if (!args.epicPatientFhirId) return [];
    return [await client.readPatient(args.epicPatientFhirId)];
  }

  const patient = args.epicPatientFhirId ?? args.patientId;
  const lastUpdated = args.watermark ? `gt${args.watermark}` : undefined;
  const baseParams: Record<string, string | undefined> = {
    patient,
    _lastUpdated: lastUpdated,
  };

  // Observation: fan out per category so Epic accepts each request.
  // Dedup by resource.id in the rare case the same observation shows
  // up under multiple categories (defensive — should not happen for
  // vital-signs vs laboratory).
  if (args.resourceType === "Observation") {
    const seen = new Set<string>();
    const out: FhirResource[] = [];
    for (const category of getObservationCategories()) {
      const params = { ...baseParams, category };
      const outcome = await collectSearchOrSkipUnauthorized(
        client,
        args.resourceType,
        params,
      );
      if (outcome.kind === "skipped") {
        skippedOut.push(outcome.entry);
        continue;
      }
      for (const r of outcome.resources) {
        if (r.id && seen.has(r.id)) continue;
        if (r.id) seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  // MedicationRequest: Epic requires `status` for unfiltered patient
  // queries. Default fan-out is a single-element `["active"]`; a
  // med-rec tenant can opt into multi-status (e.g. `active,on-hold,
  // completed`) via EPIC_MEDICATION_REQUEST_STATUS (#1114).
  //
  // Per-status soft-skip mirrors the Observation per-category path —
  // some app registrations (Order Template Medication only, for
  // example) carry the scope for some statuses but not others, so a
  // sibling-rejection on one status MUST NOT abort the others. Dedup
  // by resource.id covers the rare overlap where Epic returns the
  // same MedicationRequest under multiple statuses.
  if (args.resourceType === "MedicationRequest") {
    const seen = new Set<string>();
    const out: FhirResource[] = [];
    for (const status of getMedicationRequestStatuses()) {
      const params = { ...baseParams, status };
      const outcome = await collectSearchOrSkipUnauthorized(
        client,
        args.resourceType,
        params,
      );
      if (outcome.kind === "skipped") {
        skippedOut.push(outcome.entry);
        continue;
      }
      for (const r of outcome.resources) {
        if (r.id && seen.has(r.id)) continue;
        if (r.id) seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  const resources: FhirResource[] = [];
  for await (const r of client.searchAll(args.resourceType, baseParams)) {
    resources.push(r);
  }
  return resources;
}

async function persistOne(
  resource: FhirResource,
  resourceType: SyncResourceType,
  patientId: string,
): Promise<PersistResult> {
  switch (resourceType) {
    case "Patient":
      return persistPatient(resource);
    case "Observation":
      return persistObservation(resource, patientId);
    case "Condition":
      return persistCondition(resource, patientId);
    case "MedicationRequest":
      return persistMedicationRequest(resource, patientId);
    case "AllergyIntolerance":
      return persistAllergy(resource, patientId);
  }
}

function buildClinicalEvent(args: {
  persisted: PersistResult;
  patientId: string;
  resource: FhirResource;
}): ClinicalEvent {
  const type = eventTypeFor(args.persisted);
  return {
    id: crypto.randomUUID(),
    type,
    patient_id: args.patientId,
    timestamp: new Date().toISOString(),
    data: {
      source_system: EPIC_SOURCE_SYSTEM_TAG,
      epic_fhir_id: args.resource.id,
      epic_resource_type: args.resource.resourceType,
      internal_record_id: args.persisted.internalId,
      operation: args.persisted.inserted ? "created" : "updated",
    },
  };
}

function eventTypeFor(persisted: PersistResult): ClinicalEventType {
  switch (persisted.kind) {
    case "patient":
      return "patient.observation";
    case "vital":
      return persisted.inserted ? "vital.created" : "vital.updated";
    case "lab":
      return "lab.resulted";
    case "medication":
      return persisted.inserted
        ? "medication.created"
        : "medication.updated";
    case "diagnosis":
      return persisted.inserted ? "diagnosis.added" : "diagnosis.updated";
    case "allergy":
      return persisted.inserted ? "allergy.added" : "allergy.updated";
    case "unmapped":
      // Should never happen — buildClinicalEvent is gated by
      // persisted.kind !== "unmapped" at the callsite. Fall through to
      // a generic "fhir.imported" so the event still surfaces in
      // audit trails if a future bug breaks the gate.
      return "fhir.imported";
  }
}
