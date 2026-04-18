/**
 * Shared outbox module for clinical event emissions.
 *
 * Centralizes the write/read contract for the `failed_clinical_events`
 * outbox table so that the writer (clinical-data, clinical-notes) and
 * the reader (ai-oversight outbox-reconciler) share a single status
 * state-machine and typed surface.
 *
 * See: https://github.com/blamechris/carebridge/issues/508
 */

import { and, eq, sql, type InferSelectModel } from "drizzle-orm";
import { getDb, failedClinicalEvents } from "@carebridge/db-schema";
import type { ClinicalEvent } from "@carebridge/shared-types";

export type { ClinicalEvent };

export type OutboxRow = InferSelectModel<typeof failedClinicalEvents>;

/** Rows with retry_count equal to this after a failure are parked as `failed`. */
export const MAX_RECONCILE_RETRIES = 5;

/** Cap per run so a huge backlog cannot starve the worker. */
export const RECONCILE_BATCH_SIZE = 100;

/**
 * Rows stuck in 'processing' are only recovered if their updated_at is older
 * than this threshold. This prevents a concurrent pod's in-flight rows from
 * being stolen — only genuinely stale rows (from a crashed pod) are reset.
 */
export const STALE_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ── Write surface ──────────────────────────────────────────────────

/**
 * Persist a clinical event to the outbox table when the primary BullMQ
 * emit fails. Replaces inline INSERTs in service-level events.ts files.
 */
export async function writeOutboxEntry(
  event: ClinicalEvent,
  error: Error | string,
): Promise<void> {
  const db = getDb();
  const errorMessage = error instanceof Error ? error.message : String(error);

  await db.insert(failedClinicalEvents).values({
    id: crypto.randomUUID(),
    event_type: event.type,
    patient_id: event.patient_id,
    event_payload: event,
    error_message: errorMessage,
    status: "pending",
    retry_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// ── Read surface ───────────────────────────────────────────────────

/**
 * Recover rows orphaned by a prior crashed reconciler tick. A row in
 * status='processing' whose updated_at is older than the stale threshold
 * is orphaned — the claiming pod has crashed. Flipping back to 'pending'
 * makes the row claimable again. The time guard ensures in-flight rows
 * from a concurrent pod (recently claimed, updated_at is fresh) are NOT
 * stolen. retry_count is left alone: the crashed attempt did not consume
 * a retry.
 */
export async function recoverStaleProcessing(): Promise<void> {
  const db = getDb();
  const staleCutoff = new Date(
    Date.now() - STALE_PROCESSING_THRESHOLD_MS,
  ).toISOString();

  await db
    .update(failedClinicalEvents)
    .set({ status: "pending", updated_at: new Date().toISOString() })
    .where(
      and(
        eq(failedClinicalEvents.status, "processing"),
        sql`(${failedClinicalEvents.updated_at} IS NULL OR ${failedClinicalEvents.updated_at} < ${staleCutoff})`,
      ),
    );
}

/**
 * Atomic claim. UPDATE...WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 * RETURNING * is a single statement — it auto-commits the status transition
 * before the caller proceeds to enqueue. Concurrent pods contending for the
 * same rows have their subquery locks acquired under SKIP LOCKED, so each
 * pod sees a disjoint batch.
 */
export async function readPendingBatch(
  limit: number = RECONCILE_BATCH_SIZE,
): Promise<OutboxRow[]> {
  const db = getDb();

  const claimed = (await db
    .update(failedClinicalEvents)
    .set({ status: "processing", updated_at: new Date().toISOString() })
    .where(
      sql`${failedClinicalEvents.id} IN (
        SELECT ${failedClinicalEvents.id}
        FROM ${failedClinicalEvents}
        WHERE ${failedClinicalEvents.status} = 'pending'
          AND ${failedClinicalEvents.retry_count} < ${MAX_RECONCILE_RETRIES}
        ORDER BY ${failedClinicalEvents.created_at} ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )`,
    )
    .returning()) as OutboxRow[];

  return claimed;
}

/**
 * Mark a row as successfully processed with a processed_at timestamp.
 */
export async function markProcessed(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(failedClinicalEvents)
    .set({
      status: "processed",
      updated_at: now,
      processed_at: now,
    })
    .where(eq(failedClinicalEvents.id, id));
}

/**
 * Increment retry_count and flip from 'processing' back to 'pending'
 * for re-claim on the next tick.
 */
export async function markRetry(
  id: string,
  error: Error | string,
): Promise<void> {
  const db = getDb();
  const errorMessage = error instanceof Error ? error.message : String(error);

  await db
    .update(failedClinicalEvents)
    .set({
      status: "pending",
      retry_count: sql`${failedClinicalEvents.retry_count} + 1`,
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
      processed_at: null,
    })
    .where(eq(failedClinicalEvents.id, id));
}

/**
 * Mark a row as terminally failed — it has exhausted its retries.
 * Sets processed_at so ops can see when we gave up.
 */
export async function markFailed(
  id: string,
  error: Error | string,
): Promise<void> {
  const db = getDb();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();

  await db
    .update(failedClinicalEvents)
    .set({
      status: "failed",
      retry_count: sql`${failedClinicalEvents.retry_count} + 1`,
      error_message: errorMessage,
      updated_at: now,
      processed_at: now,
    })
    .where(eq(failedClinicalEvents.id, id));
}
