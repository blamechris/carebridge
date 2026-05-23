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
import { EpicFhirClient, type EpicResourceType } from "../fhir-client.js";
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

export interface SyncResult {
  patient_id: string;
  resource_type: SyncResourceType;
  imported: number;
  updated: number;
  conflicts: number;
  errors: string[];
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
  };
  let highWatermark: string | null = args.watermark;

  try {
    const resources = await fetchResources(args, deps.client);

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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Epic sync — resource-type failure", {
      patientId: args.patientId,
      resourceType: args.resourceType,
      error: message,
    });
    await markFailed({
      patientId: args.patientId,
      resourceType: args.resourceType,
      errorMessage: message,
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
 */
const OBSERVATION_CATEGORY_FANOUT = ["vital-signs", "laboratory"] as const;

/**
 * Epic's R4 endpoint rejects `MedicationRequest?patient=X` without a
 * `status` filter ("Combination of parameters is not valid"). Default
 * to `active` since stopped/cancelled meds aren't clinically actionable
 * for the AI oversight pipeline. Callers needing the full history can
 * pass an override via the worker dispatch in a future iteration.
 */
const MEDICATION_REQUEST_DEFAULT_STATUS = "active";

/**
 * Detect Epic's "not authorized for this sub-resource" 400 response so the
 * fan-out can skip categories the registered app doesn't carry the scope
 * for. Epic emits this as a 400 with a 59022 code; we match on the human
 * text since the error code is buried in an OperationOutcome JSON blob
 * which the FHIR client surfaces as the trailing string of the Error.
 */
function isUnauthorizedSubResourceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("Combination of parameters is not valid") ||
    err.message.includes("authorized sub-resource")
  );
}

async function collectSearchOrSkipUnauthorized(
  client: EpicFhirClient,
  resourceType: SyncResourceType,
  params: Record<string, string | undefined>,
): Promise<FhirResource[] | null> {
  const out: FhirResource[] = [];
  try {
    for await (const r of client.searchAll(resourceType, params)) {
      out.push(r);
    }
    return out;
  } catch (err) {
    if (isUnauthorizedSubResourceError(err)) {
      log.warn(
        "Epic sync — skipping unauthorized sub-resource (registered scopes don't cover this filter)",
        {
          resourceType,
          params: Object.entries(params)
            .filter(([k]) => k !== "patient")
            .reduce<Record<string, string | undefined>>((acc, [k, v]) => {
              acc[k] = v;
              return acc;
            }, {}),
        },
      );
      return null;
    }
    throw err;
  }
}

async function fetchResources(
  args: SyncOneArgs,
  client: EpicFhirClient,
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
    for (const category of OBSERVATION_CATEGORY_FANOUT) {
      const params = { ...baseParams, category };
      const batch = await collectSearchOrSkipUnauthorized(
        client,
        args.resourceType,
        params,
      );
      if (batch === null) continue;
      for (const r of batch) {
        if (r.id && seen.has(r.id)) continue;
        if (r.id) seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  // MedicationRequest: Epic requires `status` for unfiltered patient
  // queries. Some app registrations (Order Template Medication only,
  // for example) won't accept any `?patient=X` query — fail soft so
  // the rest of the sync still runs.
  if (args.resourceType === "MedicationRequest") {
    const params = { ...baseParams, status: MEDICATION_REQUEST_DEFAULT_STATUS };
    const batch = await collectSearchOrSkipUnauthorized(
      client,
      args.resourceType,
      params,
    );
    return batch ?? [];
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
