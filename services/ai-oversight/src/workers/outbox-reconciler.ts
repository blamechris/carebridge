/**
 * Outbox reconciler for clinical-event emissions.
 *
 * When the primary BullMQ emit in `emitClinicalEvent` fails (Redis down,
 * network blip, auth failure), the event is written to the `failed_clinical_events`
 * outbox table so the oversight pipeline doesn't silently lose data — HIPAA
 * audit + clinical-safety both require that every write reaches the review
 * engine. The write-side is the *outbox*. This is the *drain*.
 *
 * The read/write contract for the outbox table is centralized in
 * `@carebridge/outbox` (issue #508). This file is the scheduling and
 * orchestration layer that wires the shared outbox operations to BullMQ.
 *
 * Responsibilities:
 *   1. Recover any rows stuck in status='processing' from a prior crashed tick.
 *   2. Atomically claim a batch of status='pending' rows (flip to 'processing').
 *   3. Re-enqueue each claimed payload on the clinical-events BullMQ queue.
 *   4. On success: mark the row status='processed' (processed_at stamped).
 *   5. On failure below the retry cap: increment retry_count, flip back to 'pending'.
 *   6. On failure at the retry cap: mark status='failed' — this row is now
 *      a candidate for operator-driven review; it will not be retried again.
 *
 * Failure-rate observability comes from the per-run return value:
 * `{ reconciled, retried, failed }`. `startOutboxReconcilerWorker` logs
 * this structured record on every tick so ops can alert on `failed > 0`
 * or on elevated `retried` counts even without a metrics backend.
 */

import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import {
  recoverStaleProcessing,
  readPendingBatch,
  markProcessed,
  markRetry,
  markFailed,
  MAX_RECONCILE_RETRIES,
  RECONCILE_BATCH_SIZE,
  STALE_PROCESSING_THRESHOLD_MS,
  type OutboxRow,
} from "@carebridge/outbox";

const RECONCILER_QUEUE_NAME = "outbox-reconciler";
const CLINICAL_EVENTS_QUEUE_NAME = "clinical-events";

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
  const queue = getClinicalEventsQueue();

  // Step 1: Recover rows orphaned by a prior crashed tick.
  await recoverStaleProcessing();

  // Step 2: Atomic claim via shared outbox module.
  const claimed = await readPendingBatch();

  let reconciled = 0;
  let retried = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      // jobId: row.id — BullMQ dedupes by outbox row id.
      await queue.add(row.event_type, row.event_payload, { jobId: row.id });
      await markProcessed(row.id);
      reconciled++;
    } catch (err) {
      const nextRetry = (row.retry_count ?? 0) + 1;
      const isTerminal = nextRetry >= MAX_RECONCILE_RETRIES;
      const error = err instanceof Error ? err : new Error(String(err));

      if (isTerminal) {
        await markFailed(row.id, error);
        failed++;
      } else {
        await markRetry(row.id, error);
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
      removeOnComplete: { age: 2 * RECONCILE_INTERVAL_MS / 1000, count: 100 },
      removeOnFail: { count: 100 },
    },
  });

  // Fire-and-log — if Redis isn't ready at boot, surface the error so the
  // deployment doesn't run silently with no reconciler scheduled.
  queue
    .add(
      "reconcile",
      {},
      {
        repeat: { every: RECONCILE_INTERVAL_MS },
        jobId: "outbox-reconciler-repeatable",
      },
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[outbox-reconciler] failed to register repeatable job: ${message}`,
      );
    });

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

export {
  RECONCILER_QUEUE_NAME,
  RECONCILE_INTERVAL_MS,
  MAX_RECONCILE_RETRIES,
  RECONCILE_BATCH_SIZE,
  STALE_PROCESSING_THRESHOLD_MS,
};
