/**
 * Flag escalation worker.
 *
 * Periodically checks for unacknowledged critical flags that have exceeded
 * their escalation threshold. When found, updates the flag status to
 * "escalated" and emits notification events to a broader audience.
 *
 * Thresholds:
 *  - Critical flags: 30 minutes
 *  - Warning flags: 2 hours
 *
 * Runs as a BullMQ repeatable job (every 5 minutes by default).
 */

import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { redactPatientId } from "@carebridge/phi-sanitizer";
import { getDb } from "@carebridge/db-schema";
import { clinicalFlags } from "@carebridge/db-schema";
import { eq, and, lt, isNull } from "drizzle-orm";

const QUEUE_NAME = "escalation-checks";

const connection = getRedisConnection();

/** Escalation thresholds in milliseconds. */
const THRESHOLDS = {
  critical: 30 * 60 * 1000,  // 30 minutes
  warning: 2 * 60 * 60 * 1000, // 2 hours
} as const;

/** How often the check runs (ms). */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Notification queue reference — we emit escalation notifications here.
 * The notification dispatch worker picks these up and creates user records.
 */
const notificationsQueue = new Queue("notifications", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Check for unacknowledged flags past their escalation threshold and escalate them.
 */
async function checkAndEscalate(): Promise<{ escalated: number }> {
  const db = getDb();
  const now = Date.now();
  let escalated = 0;

  for (const [severity, thresholdMs] of Object.entries(THRESHOLDS)) {
    const cutoff = new Date(now - thresholdMs).toISOString();

    // Find open, unacknowledged flags of this severity created before the cutoff
    const staleFlags = await db
      .select()
      .from(clinicalFlags)
      .where(
        and(
          eq(clinicalFlags.status, "open"),
          eq(clinicalFlags.severity, severity),
          isNull(clinicalFlags.acknowledged_at),
          lt(clinicalFlags.created_at, cutoff),
        ),
      );

    for (const flag of staleFlags) {
      // Update status to escalated
      await db
        .update(clinicalFlags)
        .set({
          status: "escalated",
        })
        .where(eq(clinicalFlags.id, flag.id));

      // Emit escalation notification — broader audience than original
      const notifySpecialties = (flag.notify_specialties as string[]) ?? [];
      await notificationsQueue.add("flag-escalated", {
        flag_id: flag.id,
        patient_id: flag.patient_id,
        severity: flag.severity,
        category: flag.category,
        summary: `ESCALATED: ${flag.summary}`,
        suggested_action: flag.suggested_action,
        notify_specialties: notifySpecialties,
        source: flag.source,
        created_at: flag.created_at,
      });

      escalated++;

      console.log(
        `[escalation-worker] Escalated flag ${flag.id} ` +
          `(severity: ${flag.severity}, patient: ${redactPatientId(flag.patient_id)}, ` +
          `age: ${Math.round((now - new Date(flag.created_at).getTime()) / 60000)}min)`,
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
      console.log(`[escalation-worker] Running escalation check (job ${job.id})`);
      const startTime = Date.now();

      const result = await checkAndEscalate();

      const elapsed = Date.now() - startTime;
      console.log(
        `[escalation-worker] Check complete in ${elapsed}ms — ${result.escalated} flags escalated`,
      );

      return result;
    },
    {
      connection,
      concurrency: 1, // Only one check at a time
    },
  );

  worker.on("ready", () => {
    console.log(`[escalation-worker] Worker ready, processing "${QUEUE_NAME}" queue`);
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
