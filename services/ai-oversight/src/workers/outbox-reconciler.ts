/**
 * Outbox reconciler for clinical-event emissions.
 *
 * When the primary BullMQ emit in `emitClinicalEvent` fails (Redis down,
 * network blip, auth failure), the event is written to the `failed_clinical_events`
 * outbox table so the oversight pipeline doesn't silently lose data — HIPAA
 * audit + clinical-safety both require that every write reaches the review
 * engine. The write-side is the *outbox*. This is the *drain*.
 *
 * Responsibilities:
 *   1. Periodically scan the outbox for rows with status='pending'.
 *   2. Re-enqueue the stored payload on the clinical-events BullMQ queue.
 *   3. On success: mark the row status='processed' (processed_at stamped).
 *   4. On failure below the retry cap: increment retry_count, keep pending.
 *   5. On failure at the retry cap: mark status='failed' — this row is now
 *      a candidate for operator-driven review; it will not be retried again.
 *
 * Failure-rate observability comes from the per-run return value:
 * `{ reconciled, retried, failed }`. `startOutboxReconcilerWorker` logs
 * this structured record on every tick so ops can alert on `failed > 0`
 * or on elevated `retried` counts even without a metrics backend.
 */

import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { and, eq, lt } from "drizzle-orm";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import { getDb, failedClinicalEvents } from "@carebridge/db-schema";

const RECONCILER_QUEUE_NAME = "outbox-reconciler";
const CLINICAL_EVENTS_QUEUE_NAME = "clinical-events";

/** Rows with retry_count equal to this after a failure are parked as `failed`. */
export const MAX_RECONCILE_RETRIES = 5;

/** Cap per run so a huge backlog cannot starve the worker. */
export const RECONCILE_BATCH_SIZE = 100;

/** How often the reconciler runs. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const connection = getRedisConnection();

// Lazy init — tests mock the BullMQ Queue ctor, and production wants a
// singleton so repeated ticks reuse the same client.
let clinicalEventsQueue: Queue | null = null;
function getClinicalEventsQueue(): Queue {
  if (!clinicalEventsQueue) {
    clinicalEventsQueue = new Queue(CLINICAL_EVENTS_QUEUE_NAME, {
      connection,
      defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
    });
  }
  return clinicalEventsQueue;
}

export interface ReconcileResult {
  reconciled: number;
  retried: number;
  failed: number;
}

/**
 * Drain one batch of pending outbox rows. Exported for tests.
 */
export async function reconcileFailedEvents(): Promise<ReconcileResult> {
  const db = getDb();
  const queue = getClinicalEventsQueue();

  const pending = await db
    .select()
    .from(failedClinicalEvents)
    .where(
      and(
        eq(failedClinicalEvents.status, "pending"),
        lt(failedClinicalEvents.retry_count, MAX_RECONCILE_RETRIES),
      ),
    )
    .limit(RECONCILE_BATCH_SIZE);

  let reconciled = 0;
  let retried = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await queue.add(row.event_type, row.event_payload);

      await db
        .update(failedClinicalEvents)
        .set({
          status: "processed",
          processed_at: new Date().toISOString(),
        })
        .where(eq(failedClinicalEvents.id, row.id));

      reconciled++;
    } catch (err) {
      const nextRetry = (row.retry_count ?? 0) + 1;
      const isTerminal = nextRetry >= MAX_RECONCILE_RETRIES;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(failedClinicalEvents)
        .set({
          status: isTerminal ? "failed" : "pending",
          retry_count: nextRetry,
          error_message: errorMessage,
          // Stamp processed_at on terminal failure so ops can see when we
          // gave up. Kept null for retryable failures — we're not done yet.
          processed_at: isTerminal ? new Date().toISOString() : null,
        })
        .where(eq(failedClinicalEvents.id, row.id));

      if (isTerminal) {
        failed++;
      } else {
        retried++;
      }
    }
  }

  return { reconciled, retried, failed };
}

/**
 * Register the reconciler's repeatable job.
 */
export function setupOutboxReconcilerQueue(): Queue {
  const queue = new Queue(RECONCILER_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });

  queue.add(
    "reconcile",
    {},
    {
      repeat: { every: RECONCILE_INTERVAL_MS },
      jobId: "outbox-reconciler-repeatable",
    },
  );

  return queue;
}

/**
 * Start the reconciler worker.
 */
export function startOutboxReconcilerWorker(): Worker {
  const worker = new Worker(
    RECONCILER_QUEUE_NAME,
    async (job: Job) => {
      const startTime = Date.now();
      const result = await reconcileFailedEvents();
      const elapsed = Date.now() - startTime;

      // Structured line — cheap to grep, easy to alert on `failed>0`.
      console.log(
        `[outbox-reconciler] job=${job.id} elapsed_ms=${elapsed} ` +
          `reconciled=${result.reconciled} retried=${result.retried} failed=${result.failed}`,
      );

      return result;
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("ready", () => {
    console.log(
      `[outbox-reconciler] Worker ready, processing "${RECONCILER_QUEUE_NAME}" queue`,
    );
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(
      `[outbox-reconciler] Job ${job?.id} failed: ${error.message}`,
    );
  });

  worker.on("error", (error: Error) => {
    console.error(`[outbox-reconciler] Worker error: ${error.message}`);
  });

  return worker;
}

export { RECONCILER_QUEUE_NAME, RECONCILE_INTERVAL_MS };
