/**
 * BullMQ worker that dispatches notifications to relevant users.
 *
 * When a clinical flag is created, this worker:
 * 1. Looks up the patient's care team members
 * 2. Filters the recipient set by specialty when `notify_specialties`
 *    is non-empty (HIPAA minimum-necessary, § 164.502(b))
 * 3. Creates notification records only for matched recipients
 *
 * When `notify_specialties` is empty/null the notification falls back to
 * every active care team provider for the patient.
 */

import { Worker, Queue } from "bullmq";
import type { Job } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { getDb } from "@carebridge/db-schema";
import { notifications, users, careTeamAssignments } from "@carebridge/db-schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import type { NotificationEvent } from "../queue.js";
import { notificationsQueue } from "../queue.js";
import { publishNotification } from "../publish.js";
import { redactPatientId } from "@carebridge/phi-sanitizer";
import { filterRecipientsBySpecialty } from "./specialty-filter.js";
import type { CandidateRecipient } from "./specialty-filter.js";
import { getUserPreferences, evaluateDelivery } from "./preferences.js";

const QUEUE_NAME = "notifications";
const DLQ_NAME = "notifications-failed";

const connection = getRedisConnection();

const dlq = new Queue(DLQ_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

/**
 * Find provider user IDs who should receive a notification for a given flag.
 *
 * Strategy:
 * 1. Look up active care_team_assignments for the patient — this is the
 *    RBAC source-of-truth that determines which users have access to the
 *    patient's records. Using this table (instead of care_team_members)
 *    ensures we only notify users who can actually act on the flag.
 * 2. Load their user rows (id, specialty, role, is_active)
 * 3. If `notify_specialties` is non-empty, use `filterRecipientsBySpecialty`
 *    to keep only providers whose specialty matches (plus admins).
 *    We do NOT silently fall back to the entire care team when the match
 *    set is empty — that would re-disclose PHI to unrelated providers.
 * 4. If `notify_specialties` is empty, notify every active care team
 *    provider (legacy behaviour for flags without a targeted specialty).
 */
async function findNotificationRecipients(
  patientId: string,
  notifySpecialties: string[],
): Promise<string[]> {
  const db = getDb();

  // Get all active care team assignments (RBAC) for this patient.
  // A row with removed_at = null is an active assignment.
  const assignments = await db
    .select({ user_id: careTeamAssignments.user_id })
    .from(careTeamAssignments)
    .where(
      and(
        eq(careTeamAssignments.patient_id, patientId),
        isNull(careTeamAssignments.removed_at),
      ),
    );

  if (assignments.length === 0) return [];

  const assignedUserIds = assignments.map((a) => a.user_id);

  // Load all active providers on the care team with their specialty + role
  const activeProviders = await db
    .select({
      id: users.id,
      specialty: users.specialty,
      role: users.role,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, assignedUserIds),
        eq(users.is_active, true),
      ),
    );

  const candidates: CandidateRecipient[] = activeProviders.map((p) => ({
    id: p.id,
    specialty: p.specialty,
    role: p.role,
  }));

  return filterRecipientsBySpecialty(candidates, notifySpecialties);
}

/**
 * Build a notification title based on flag severity and category.
 */
function buildNotificationTitle(event: NotificationEvent): string {
  const severityLabel = event.severity === "critical" ? "CRITICAL" : event.severity === "warning" ? "Warning" : "Info";
  return `${severityLabel}: Clinical flag — ${event.category.replace(/-/g, " ")}`;
}

/**
 * Build a deep link to the flag in the clinician portal.
 */
function buildFlagLink(event: NotificationEvent): string {
  return `/patients?flagId=${event.flag_id}`;
}

/**
 * Determine whether a flag should generate urgent notifications.
 * Critical and high severity flags are urgent — they bypass quiet hours
 * and render with prominent visual indicators in the clinician portal.
 */
function isUrgentFlag(severity: string): boolean {
  return severity === "critical" || severity === "high";
}

/**
 * Process a single notification event: find recipients, check preferences,
 * and create notification records.
 *
 * For each recipient the worker:
 * 1. Queries notification preferences
 * 2. Skips disabled channels (unless critical)
 * 3. Delays delivery during quiet hours (unless critical)
 * Critical notifications (severity === "critical") always bypass quiet hours
 * and disabled-channel preferences to ensure clinical safety.
 */
async function processNotificationJob(event: NotificationEvent): Promise<number> {
  const db = getDb();

  const recipientIds = await findNotificationRecipients(
    event.patient_id,
    event.notify_specialties,
  );

  if (recipientIds.length === 0) {
    console.log(
      `[dispatch-worker] No recipients found for flag ${event.flag_id} ` +
        `(patient: ${redactPatientId(event.patient_id)}, specialties: ${event.notify_specialties.join(", ")})`,
    );
    return 0;
  }

  const title = buildNotificationTitle(event);
  const link = buildFlagLink(event);
  const now = new Date().toISOString();
  const urgent = isUrgentFlag(event.severity);

  let immediateCount = 0;
  let delayedCount = 0;
  let skippedCount = 0;

  const immediateRecords: Array<{
    id: string;
    user_id: string;
    type: "ai-flag";
    title: string;
    body: string;
    link: string;
    related_flag_id: string;
    is_urgent: boolean;
    is_read: boolean;
    created_at: string;
  }> = [];

  for (const userId of recipientIds) {
    const preferences = await getUserPreferences(userId);
    const decision = evaluateDelivery(preferences, "ai-flag", event.severity);

    if (!decision.deliver_in_app) {
      skippedCount++;
      console.log(
        `[dispatch-worker] Skipping notification for user ${userId} — channel disabled`,
      );
      continue;
    }

    if (decision.delay_ms > 0) {
      // Re-queue the notification with a delay for this specific user.
      // We create a targeted delayed job rather than holding the current job.
      delayedCount++;
      console.log(
        `[dispatch-worker] Delaying notification for user ${userId} by ${Math.round(decision.delay_ms / 60000)}min (quiet hours)`,
      );
      await notificationsQueue.add(
        "delayed-single",
        {
          ...event,
          _targeted_user_id: userId,
        },
        { delay: decision.delay_ms },
      );
      continue;
    }

    immediateRecords.push({
      id: crypto.randomUUID(),
      user_id: userId,
      type: "ai-flag" as const,
      title,
      body: event.summary,
      link,
      related_flag_id: event.flag_id,
      is_urgent: urgent,
      is_read: false,
      created_at: now,
    });
    immediateCount++;
  }

  // Batch insert immediate notifications
  if (immediateRecords.length > 0) {
    await db.insert(notifications).values(immediateRecords);
  }

  // Publish to Redis pub/sub for real-time SSE delivery.
  // Best-effort: failures are logged but do not cause job retry
  // (which would duplicate the already-inserted notification rows).
  for (const record of immediateRecords) {
    try {
      await publishNotification(record.user_id, {
        id: record.id,
        type: record.type,
        title: record.title,
        body: record.body,
        link: record.link,
        related_flag_id: record.related_flag_id,
        is_urgent: record.is_urgent,
        created_at: record.created_at,
      });
    } catch (error) {
      console.error("[dispatch-worker] Failed to publish notification to Redis", {
        notificationId: record.id,
        userId: record.user_id,
        error,
      });
    }
  }

  console.log(
    `[dispatch-worker] Flag ${event.flag_id} (severity: ${event.severity}): ` +
      `${immediateCount} immediate, ${delayedCount} delayed, ${skippedCount} skipped`,
  );

  return immediateCount;
}

/**
 * Process a delayed single-user notification that was re-queued after quiet hours.
 */
async function processDelayedNotification(event: NotificationEvent & { _targeted_user_id: string }): Promise<number> {
  const db = getDb();
  const userId = event._targeted_user_id;
  const title = buildNotificationTitle(event);
  const link = buildFlagLink(event);
  const now = new Date().toISOString();

  const record = {
    id: crypto.randomUUID(),
    user_id: userId,
    type: "ai-flag" as const,
    title,
    body: event.summary,
    link,
    related_flag_id: event.flag_id,
    is_urgent: isUrgentFlag(event.severity),
    is_read: false,
    created_at: now,
  };

  await db.insert(notifications).values(record);

  try {
    await publishNotification(record.user_id, {
      id: record.id,
      type: record.type,
      title: record.title,
      body: record.body,
      link: record.link,
      related_flag_id: record.related_flag_id,
      is_urgent: record.is_urgent,
      created_at: record.created_at,
    });
  } catch (error) {
    console.error("[dispatch-worker] Failed to publish delayed notification to Redis", {
      notificationId: record.id,
      userId: record.user_id,
      error,
    });
  }

  console.log(
    `[dispatch-worker] Delivered delayed notification ${record.id} to user ${userId} for flag ${event.flag_id}`,
  );

  return 1;
}

/**
 * Create and start the notification dispatch worker.
 */
export function startDispatchWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const event = job.data as NotificationEvent & { _targeted_user_id?: string };

      console.log(
        `[dispatch-worker] Processing job ${job.id} — flag: ${event.flag_id} ` +
          `(severity: ${event.severity}, patient: ${redactPatientId(event.patient_id)})`,
      );

      const startTime = Date.now();

      try {
        let count: number;

        if (job.name === "delayed-single" && event._targeted_user_id) {
          console.log(
            `[dispatch-worker] Processing delayed job ${job.id} — flag: ${event.flag_id} ` +
              `(user: ${event._targeted_user_id})`,
          );
          count = await processDelayedNotification(
            event as NotificationEvent & { _targeted_user_id: string },
          );
        } else {
          count = await processNotificationJob(event);
        }

        const elapsed = Date.now() - startTime;
        console.log(
          `[dispatch-worker] Job ${job.id} completed in ${elapsed}ms — ${count} notifications created`,
        );
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[dispatch-worker] Job ${job.id} failed after ${elapsed}ms: ${message}`,
        );
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on("ready", () => {
    console.log(`[dispatch-worker] Worker ready, listening on queue "${QUEUE_NAME}"`);
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const isExhausted = attemptsMade >= maxAttempts;

    console.error(
      `[dispatch-worker] Job ${job?.id} failed (attempt ${attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    if (isExhausted && job != null) {
      const dlqPayload = {
        originalJobId: job.id,
        originalQueue: QUEUE_NAME,
        jobData: job.data as NotificationEvent,
        failedAt: new Date().toISOString(),
        finalError: error.message,
        attemptsMade,
      };

      dlq.add("dead-letter", dlqPayload).catch((dlqError: unknown) => {
        const msg = dlqError instanceof Error ? dlqError.message : String(dlqError);
        console.error(
          `[dispatch-worker] Failed to move job ${job.id} to DLQ: ${msg}`,
        );
      });
    }
  });

  worker.on("error", (error: Error) => {
    console.error(`[dispatch-worker] Worker error: ${error.message}`);
  });

  return worker;
}
