/**
 * Flag escalation worker.
 *
 * Periodically checks for unacknowledged open flags that have exceeded their
 * escalation threshold and re-notifies the care team with higher urgency.
 *
 * Clinical rationale:
 *   A critical flag that sits unread is functionally equivalent to no flag
 *   at all. Re-notifying the care team — and eventually marking the flag as
 *   escalated so it surfaces to supervising staff — bounds the window in
 *   which a stale alert can go unnoticed.
 *
 * Escalation policy:
 *   - Severity `critical` escalates after 30 minutes of no acknowledgement.
 *   - Severity `warning` escalates after 2 hours of no acknowledgement.
 *   - Each flag is escalated at most MAX_ESCALATIONS (3) times. After the
 *     final escalation the flag's status is moved to `escalated` so the
 *     scan no longer matches it.
 *   - The worker re-checks every CHECK_INTERVAL_MS. A flag becomes eligible
 *     for its next escalation when
 *       (now - last_escalated_at) >= threshold
 *     so the interval between re-notifications scales with severity.
 *
 * Infrastructure:
 *   BullMQ repeatable job (every 15 minutes). Only one instance runs at a
 *   time (concurrency=1) so escalations are not double-counted when the
 *   worker pool is larger than one.
 */

import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { redactPatientId } from "@carebridge/phi-sanitizer";
import { getDb } from "@carebridge/db-schema";
import { clinicalFlags } from "@carebridge/db-schema";
import { eq, and, lt, isNull, sql } from "drizzle-orm";
import { emitNotificationEvent } from "@carebridge/notifications";

const QUEUE_NAME = "escalation-checks";

const connection = getRedisConnection();

/** Escalation thresholds in milliseconds. */
export const THRESHOLDS: Record<string, number> = {
  critical: 30 * 60 * 1000, // 30 minutes
  warning: 2 * 60 * 60 * 1000, // 2 hours
};

/** Maximum number of re-notifications per flag before it is marked escalated. */
export const MAX_ESCALATIONS = 3;

/** How often the check runs (ms). */
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check for unacknowledged flags past their escalation threshold and escalate them.
 *
 * Exported for tests.
 */
export async function checkAndEscalate(): Promise<{ escalated: number }> {
  const db = getDb();
  const now = Date.now();
  let escalated = 0;

  for (const severity of Object.keys(THRESHOLDS)) {
    const thresholdMs = THRESHOLDS[severity];
    const cutoff = new Date(now - thresholdMs).toISOString();

    // An open, unacknowledged flag is eligible for re-escalation when:
    //   (a) it has never been escalated and it is older than the threshold, OR
    //   (b) its last escalation was more than one threshold-interval ago.
    // In both cases escalation_count must still be under the cap.
    const staleFlags = await db
      .select()
      .from(clinicalFlags)
      .where(
        and(
          eq(clinicalFlags.status, "open"),
          eq(clinicalFlags.severity, severity),
          isNull(clinicalFlags.acknowledged_at),
          lt(clinicalFlags.escalation_count, MAX_ESCALATIONS),
          sql`(
            (${clinicalFlags.last_escalated_at} IS NULL
              AND ${clinicalFlags.created_at} < ${cutoff})
            OR (${clinicalFlags.last_escalated_at} IS NOT NULL
              AND ${clinicalFlags.last_escalated_at} < ${cutoff})
          )`,
        ),
      );

    if (staleFlags.length === 0) continue;

    for (const flag of staleFlags) {
      const nextCount = (flag.escalation_count ?? 0) + 1;
      const isFinalEscalation = nextCount >= MAX_ESCALATIONS;
      const nowIso = new Date(now).toISOString();

      // Update the flag first — this is the idempotency boundary.
      // If the notification emit fails we have still recorded the
      // attempt; the job retry will not re-escalate because
      // last_escalated_at has moved forward.
      await db
        .update(clinicalFlags)
        .set({
          escalation_count: nextCount,
          last_escalated_at: nowIso,
          // Only flip to `escalated` on the final re-notification so earlier
          // passes can still find the flag in status='open'. This keeps the
          // audit trail intact: an escalated flag was escalated to the cap.
          status: isFinalEscalation ? "escalated" : "open",
        })
        .where(eq(clinicalFlags.id, flag.id));

      // Re-notify. The dispatch-worker treats severity='critical' as urgent
      // (`is_urgent=true`), so prefixing the summary with `ESCALATED` plus
      // the attempt count is sufficient to surface the heightened urgency
      // to the UI without a separate schema field.
      const notifySpecialties = (flag.notify_specialties as string[]) ?? [];
      await emitNotificationEvent({
        flag_id: flag.id,
        patient_id: flag.patient_id,
        severity: flag.severity,
        category: flag.category,
        summary: `ESCALATED (${nextCount}/${MAX_ESCALATIONS}): ${flag.summary}`,
        suggested_action: flag.suggested_action,
        notify_specialties: notifySpecialties,
        source: flag.source,
        created_at: flag.created_at,
      });

      escalated++;

      const ageMin = Math.round(
        (now - new Date(flag.created_at).getTime()) / 60000,
      );
      console.log(
        `[escalation-worker] Escalated flag ${flag.id} ` +
          `(severity: ${flag.severity}, patient: ${redactPatientId(flag.patient_id)}, ` +
          `age: ${ageMin}min, attempt: ${nextCount}/${MAX_ESCALATIONS}` +
          `${isFinalEscalation ? ", final" : ""})`,
      );
    }
  }

  return { escalated };
}

/**
 * Create the escalation check queue and schedule the repeatable job.
 */
export function setupEscalationQueue(): Queue {
  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });

  // Add repeatable job — runs every CHECK_INTERVAL_MS
  queue.add(
    "check-escalation",
    {},
    {
      repeat: { every: CHECK_INTERVAL_MS },
      jobId: "escalation-check-repeatable",
    },
  );

  return queue;
}

/**
 * Start the escalation check worker.
 */
export function startEscalationWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      console.log(
        `[escalation-worker] Running escalation check (job ${job.id})`,
      );
      const startTime = Date.now();

      const result = await checkAndEscalate();

      const elapsed = Date.now() - startTime;
      console.log(
        `[escalation-worker] Check complete in ${elapsed}ms — ` +
          `${result.escalated} flags escalated`,
      );

      return result;
    },
    {
      connection,
      concurrency: 1, // Only one check at a time
    },
  );

  worker.on("ready", () => {
    console.log(
      `[escalation-worker] Worker ready, processing "${QUEUE_NAME}" queue`,
    );
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(
      `[escalation-worker] Job ${job?.id} failed: ${error.message}`,
    );
  });

  worker.on("error", (error: Error) => {
    console.error(`[escalation-worker] Worker error: ${error.message}`);
  });

  return worker;
}

// Re-export for the service entry point and tests.
export { QUEUE_NAME, CHECK_INTERVAL_MS };
