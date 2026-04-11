/**
 * BullMQ worker that dispatches notifications to relevant users.
 *
 * When a clinical flag is created, this worker:
 * 1. Looks up the patient's care team members with matching specialties
 * 2. Creates a notification record for each relevant provider
 * 3. Falls back to all active care team members if no specialty match
 */

import { Worker, Queue } from "bullmq";
import type { Job } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { getDb } from "@carebridge/db-schema";
import { notifications, users } from "@carebridge/db-schema";
import { eq, and, inArray } from "drizzle-orm";
import Redis from "ioredis";
import crypto from "node:crypto";
import type { NotificationEvent } from "../queue.js";

/** Redis publisher client for SSE real-time delivery. */
const redisPublisher = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
  lazyConnect: true,
});

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
 * 1. Look up the patient's care team members
 * 2. Filter by notify_specialties if specified
 * 3. Fall back to all active care team providers for the patient if no specialty match
 */
async function findNotificationRecipients(
  patientId: string,
  notifySpecialties: string[],
): Promise<string[]> {
  const db = getDb();

  // Import care team members table dynamically to avoid circular deps
  const { careTeamMembers } = await import("@carebridge/db-schema");

  // Get all active care team members for this patient
  const teamMembers = await db
    .select({ provider_id: careTeamMembers.provider_id })
    .from(careTeamMembers)
    .where(
      and(
        eq(careTeamMembers.patient_id, patientId),
        eq(careTeamMembers.is_active, true),
      ),
    );

  if (teamMembers.length === 0) return [];

  const providerIds = teamMembers.map((m) => m.provider_id);

  // If specialties specified, filter providers by specialty
  if (notifySpecialties.length > 0) {
    const matchingProviders = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.id, providerIds),
          inArray(users.specialty!, notifySpecialties),
          eq(users.is_active, true),
        ),
      );

    // If we found specialty matches, use those; otherwise fall back to all team members
    if (matchingProviders.length > 0) {
      return matchingProviders.map((p) => p.id);
    }
  }

  // Fallback: notify all active care team providers (not patients)
  const activeProviders = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, providerIds),
        eq(users.is_active, true),
      ),
    );

  return activeProviders
    .map((p) => p.id);
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
 * Process a single notification event: find recipients and create notification records.
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
        `(patient: ${event.patient_id}, specialties: ${event.notify_specialties.join(", ")})`,
    );
    return 0;
  }

  const title = buildNotificationTitle(event);
  const link = buildFlagLink(event);
  const now = new Date().toISOString();

  const notificationRecords = recipientIds.map((userId) => ({
    id: crypto.randomUUID(),
    user_id: userId,
    type: "ai-flag" as const,
    title,
    body: event.summary,
    link,
    related_flag_id: event.flag_id,
    is_read: false,
    created_at: now,
  }));

  // Batch insert all notifications
  await db.insert(notifications).values(notificationRecords);

  // Publish to Redis pub/sub for real-time SSE delivery
  for (const record of notificationRecords) {
    const channel = `notifications:${record.user_id}`;
    await redisPublisher.publish(channel, JSON.stringify({
      id: record.id,
      type: record.type,
      title: record.title,
      body: record.body,
      link: record.link,
      related_flag_id: record.related_flag_id,
      created_at: record.created_at,
    }));
  }

  console.log(
    `[dispatch-worker] Created ${notificationRecords.length} notifications ` +
      `for flag ${event.flag_id} (severity: ${event.severity})`,
  );

  return notificationRecords.length;
}

/**
 * Create and start the notification dispatch worker.
 */
export function startDispatchWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const event = job.data as NotificationEvent;

      console.log(
        `[dispatch-worker] Processing job ${job.id} — flag: ${event.flag_id} ` +
          `(severity: ${event.severity}, patient: ${event.patient_id})`,
      );

      const startTime = Date.now();

      try {
        const count = await processNotificationJob(event);
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
