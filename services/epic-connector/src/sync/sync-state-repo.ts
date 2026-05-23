/**
 * Per-patient, per-resource-type sync state CRUD (#391).
 *
 * Backed by the `epic_sync_state` table introduced in migration 0048.
 * The Epic sync worker reads the watermark before each incremental
 * pull and writes back the new watermark plus the success/error counts
 * after each pull completes.
 *
 * Status state machine:
 *   pending → running → ok        (happy path)
 *   pending → running → failed    (transient error, eligible for retry)
 *
 * `last_fhir_lastupdated` is the value to feed into the NEXT
 * incremental request as `_lastUpdated=gt<value>`. It tracks the
 * highest `meta.lastUpdated` observed across the previous pull's
 * resources — NOT the wall-clock time the pull happened (those drift
 * apart when Epic back-dates resources).
 */
import { and, eq, desc, sql } from "drizzle-orm";
import { getDb, epicSyncState } from "@carebridge/db-schema";
import type { EpicResourceType } from "../fhir-client.js";

export type EpicSyncStatusValue = "pending" | "running" | "ok" | "failed";

export interface SkippedSubResourceRecord {
  filter: Record<string, string>;
  reason: "unauthorized";
}

export interface EpicSyncStateRow {
  patient_id: string;
  resource_type: EpicResourceType;
  last_synced_at: string | null;
  last_fhir_lastupdated: string | null;
  status: EpicSyncStatusValue;
  resources_synced_count: number;
  error_count: number;
  last_error_message: string | null;
  last_error_at: string | null;
  /** Sub-resource fetches Epic refused on the most recent batch (#1097). */
  skipped_sub_resources: SkippedSubResourceRecord[];
}

export async function getSyncState(
  patientId: string,
  resourceType: EpicResourceType,
): Promise<EpicSyncStateRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(epicSyncState)
    .where(
      and(
        eq(epicSyncState.patient_id, patientId),
        eq(epicSyncState.resource_type, resourceType),
      ),
    )
    .limit(1);
  return (rows[0] as EpicSyncStateRow | undefined) ?? null;
}

export async function getAllSyncStatesForPatient(
  patientId: string,
): Promise<EpicSyncStateRow[]> {
  const db = getDb();
  return (await db
    .select()
    .from(epicSyncState)
    .where(eq(epicSyncState.patient_id, patientId))) as EpicSyncStateRow[];
}

export async function markRunning(
  patientId: string,
  resourceType: EpicResourceType,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(epicSyncState)
    .values({
      patient_id: patientId,
      resource_type: resourceType,
      status: "running",
      last_synced_at: now,
    })
    .onConflictDoUpdate({
      target: [epicSyncState.patient_id, epicSyncState.resource_type],
      set: { status: "running", last_synced_at: now },
    });
}

export async function markOk(args: {
  patientId: string;
  resourceType: EpicResourceType;
  /** Highest `meta.lastUpdated` seen in this pull — watermark for next pull. */
  highWatermark: string | null;
  /** Number of resources successfully imported on this pull. */
  importedCount: number;
  /**
   * Sub-resources Epic refused on this batch (#1097). Replaces the
   * previous value so the column reflects the latest run only —
   * historical drift lives in BullMQ job logs, not here.
   */
  skipped?: SkippedSubResourceRecord[];
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const skipped = args.skipped ?? [];
  await db
    .insert(epicSyncState)
    .values({
      patient_id: args.patientId,
      resource_type: args.resourceType,
      status: "ok",
      last_synced_at: now,
      last_fhir_lastupdated: args.highWatermark,
      resources_synced_count: args.importedCount,
      skipped_sub_resources: skipped,
    })
    .onConflictDoUpdate({
      target: [epicSyncState.patient_id, epicSyncState.resource_type],
      set: {
        status: "ok",
        last_synced_at: now,
        last_fhir_lastupdated: args.highWatermark ?? sql`epic_sync_state.last_fhir_lastupdated`,
        resources_synced_count: sql`epic_sync_state.resources_synced_count + ${args.importedCount}`,
        skipped_sub_resources: skipped,
      },
    });
}

export async function markFailed(args: {
  patientId: string;
  resourceType: EpicResourceType;
  errorMessage: string;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  // Truncate error messages so a runaway stack trace doesn't bloat the
  // status column to gigabytes. 1KiB is plenty for triage; full stack
  // traces live in the worker logs / DLQ.
  const truncated = args.errorMessage.slice(0, 1024);
  await db
    .insert(epicSyncState)
    .values({
      patient_id: args.patientId,
      resource_type: args.resourceType,
      status: "failed",
      last_synced_at: now,
      last_error_message: truncated,
      last_error_at: now,
      error_count: 1,
    })
    .onConflictDoUpdate({
      target: [epicSyncState.patient_id, epicSyncState.resource_type],
      set: {
        status: "failed",
        last_synced_at: now,
        last_error_message: truncated,
        last_error_at: now,
        error_count: sql`epic_sync_state.error_count + 1`,
      },
    });
}

/**
 * List the N most recent failed sync rows across all patients —
 * powers the tRPC `listSyncErrors` query that the clinician portal's
 * Epic-sync dashboard renders.
 */
export async function listRecentFailures(
  limit = 50,
): Promise<EpicSyncStateRow[]> {
  const db = getDb();
  return (await db
    .select()
    .from(epicSyncState)
    .where(eq(epicSyncState.status, "failed"))
    .orderBy(desc(epicSyncState.last_error_at))
    .limit(limit)) as EpicSyncStateRow[];
}
