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
import { and, eq, sql } from "drizzle-orm";
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

/**
 * Rows stuck in 'processing' are only recovered if their updated_at is older
 * than this threshold. This prevents a concurrent pod's in-flight rows from
 * being stolen — only genuinely stale rows (from a crashed pod) are reset.
 */
export const STALE_PROCESSING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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

type ClaimedRow = {
  id: string;
  event_type: string;
  patient_id: string;
  event_payload: unknown;
  status: string;
  retry_count: number | null;
  created_at: string;
  updated_at: string | null;
};

/**
 * Drain one batch of pending outbox rows. Exported for tests.
 *
 * Claim-then-process (issue #507):
 *   The original drain loop was `SELECT FOR UPDATE SKIP LOCKED` then
 *   `queue.add` then `UPDATE processed`. Two correctness gaps forced a
 *   redesign:
 *
 *   1. `FOR UPDATE SKIP LOCKED` in Drizzle (outside an explicit transaction)
 *      holds the row lock only for the lifetime of the SELECT statement.
 *      The lock is gone before `queue.add` runs, so a concurrent pod
 *      could still see the same row as `status='pending'` and re-enqueue
 *      it. BullMQ `jobId` dedup masks this on the receiving side, but
 *      the outbox itself still did double work and double network I/O.
 *
 *   2. If `queue.add` succeeded and the terminal UPDATE failed (SIGTERM,
 *      pool exhaustion), the row stayed `pending` and the next tick
 *      re-emitted it. Review-service's `trigger_event_id` dedup only
 *      covers `status='completed'` review_jobs, which leaves a small
 *      window where a duplicate flag can slip through.
 *
 *   The fix: single atomic UPDATE...WHERE id IN (SELECT ... FOR UPDATE
 *   SKIP LOCKED) RETURNING *. The UPDATE auto-commits as one statement,
 *   so the transition `pending -> processing` is persistent before
 *   `queue.add` runs. A crash between claim and enqueue leaves the row
 *   pinned to `processing`; the next tick's recovery pass resets it to
 *   `pending` so it becomes claimable again.
 *
 * Stale-'processing' recovery:
 *   The first thing each tick does is reset stale `status='processing'`
 *   rows back to `pending`. A row is considered stale when its
 *   `updated_at` is older than `STALE_PROCESSING_THRESHOLD_MS` (5 min)
 *   or NULL (pre-migration rows). This time guard ensures that a
 *   concurrent pod's in-flight rows (recently claimed, fresh updated_at)
 *   are NOT stolen. Only genuinely orphaned rows — where the claiming
 *   pod has crashed — get recovered. BullMQ `jobId` dedup prevents a
 *   duplicate clinical-events job even if the orphaned claim's
 *   `queue.add` had succeeded just before the crash.
 *
 * BullMQ idempotency:
 *   `queue.add` is still called with `jobId: row.id`. Belt-and-braces
 *   with the atomic claim above and with review-service's
 *   `trigger_event_id` dedup (PR #492).
 */
export async function reconcileFailedEvents(): Promise<ReconcileResult> {
  const db = getDb();
  const queue = getClinicalEventsQueue();

  // Step 1: Recover rows orphaned by a prior crashed tick. A row in
  // status='processing' whose updated_at is older than the stale threshold
  // is orphaned — the claiming pod has crashed. Flipping back to 'pending'
  // makes the row claimable again. The time guard ensures in-flight rows
  // from a concurrent pod (recently claimed, updated_at is fresh) are NOT
  // stolen. retry_count is left alone: the crashed attempt did not consume
  // a retry. Rows with NULL updated_at (pre-migration) are treated as stale.
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

  // Step 2: Atomic claim. UPDATE...WHERE id IN (SELECT ... FOR UPDATE
  // SKIP LOCKED) RETURNING * is a single statement — it auto-commits
  // the status transition before we proceed to enqueue. Concurrent pods
  // contending for the same rows have their subquery locks acquired
  // under SKIP LOCKED, so each pod sees a disjoint batch.
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
        LIMIT ${RECONCILE_BATCH_SIZE}
      )`,
    )
    .returning()) as ClaimedRow[];

  let reconciled = 0;
  let retried = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      // jobId: row.id — BullMQ dedupes by outbox row id. If the UPDATE
      // below fails after this add resolves, the recovery pass on the
      // next tick will reset the row to 'pending' and re-claim it; the
      // subsequent queue.add with the same jobId is a no-op.
      await queue.add(row.event_type, row.event_payload, { jobId: row.id });

      const now = new Date().toISOString();
      await db
        .update(failedClinicalEvents)
        .set({
          status: "processed",
          updated_at: now,
          processed_at: now,
        })
        .where(eq(failedClinicalEvents.id, row.id));

      reconciled++;
    } catch (err) {
      const nextRetry = (row.retry_count ?? 0) + 1;
      const isTerminal = nextRetry >= MAX_RECONCILE_RETRIES;
      const errorMessage = err instanceof Error ? err.message : String(err);

      const failNow = new Date().toISOString();
      await db
        .update(failedClinicalEvents)
        .set({
          // Flip from 'processing' back to retryable 'pending', or to
          // terminal 'failed' at the cap. Leaving the row in 'processing'
          // would block the recovery pass from acting on it — we explicitly
          // relinquish the claim here.
          status: isTerminal ? "failed" : "pending",
          retry_count: nextRetry,
          error_message: errorMessage,
          updated_at: failNow,
          // Stamp processed_at on terminal failure so ops can see when we
          // gave up. Kept null for retryable failures — we're not done yet.
          processed_at: isTerminal ? failNow : null,
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

  // Fire-and-log — if Redis isn't ready at boot, surface the error so the
  // deployment doesn't run silently with no reconciler scheduled. Mirrors
  // the pattern we'd apply to setupEscalationQueue.
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

export { RECONCILER_QUEUE_NAME, RECONCILE_INTERVAL_MS };
