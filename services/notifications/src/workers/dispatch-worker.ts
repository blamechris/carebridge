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
import { createLogger } from "@carebridge/logger";
import type { NotificationEvent } from "../queue.js";
import { notificationsQueue } from "../queue.js";
import { publishNotification } from "../publish.js";
import { redactPatientId } from "@carebridge/phi-sanitizer";
import type { FlagCategory } from "@carebridge/shared-types";
import { filterRecipientsBySpecialty } from "./specialty-filter.js";
import type { CandidateRecipient } from "./specialty-filter.js";
import { getUserPreferences, evaluateDelivery } from "./preferences.js";

const log = createLogger("dispatch-worker");

/**
 * Whitelist of clinical flag categories that are safe to surface on a
 * device lock screen. This mirrors the `FlagCategory` union in
 * `@carebridge/shared-types/ai-flags` — kept as a local constant (rather
 * than deriving it from the type) so that new rule/LLM categories cannot
 * reach the lock screen without a reviewer also extending this map.
 *
 * HIPAA lock-screen safety (issue #551): `NotificationEvent.category` is
 * typed as `string` (set by rule authors and LLM output) so a
 * free-form value like `psychiatric-symptoms-self-harm` could otherwise
 * surface verbatim in a push-notification title. Every value admitted
 * here is a generic, PHI-free clinical taxonomy bucket; anything outside
 * this set falls back to `UNKNOWN_CATEGORY_LABEL` and is logged.
 */
const CATEGORY_LABELS = {
  "cross-specialty": "Cross-specialty concern",
  "drug-interaction": "Drug interaction",
  "medication-safety": "Medication safety",
  "care-gap": "Care gap",
  "critical-value": "Critical value",
  "trend-concern": "Trend concern",
  "documentation-discrepancy": "Documentation discrepancy",
  "patient-reported": "Patient-reported concern",
} as const satisfies Record<FlagCategory, string>;

type SafeCategory = keyof typeof CATEGORY_LABELS;

const UNKNOWN_CATEGORY_LABEL = "Clinical alert";

function isSafeCategory(category: string): category is SafeCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category);
}

/**
 * Resolve a category string to a lock-screen-safe human-readable label.
 * Unknown categories are replaced with a generic label and logged as a
 * structured warning so the operator can detect new rule/LLM taxonomies
 * that need review before being admitted to the whitelist.
 */
function resolveCategoryLabel(category: string): string {
  if (isSafeCategory(category)) {
    return CATEGORY_LABELS[category];
  }
  log.warn("Unknown notification category — falling back to generic label", {
    category,
    fallback: UNKNOWN_CATEGORY_LABEL,
  });
  return UNKNOWN_CATEGORY_LABEL;
}

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
 *
 * HIPAA lock-screen safety: the title MUST NOT contain patient identifiers
 * or clinical numeric values. This function produces a generic
 * "CRITICAL: Clinical flag — Critical value" form with no PHI. Upstream
 * push-notification integrations (APNs, FCM) should render only this
 * title on device lock screens; clinical detail is behind the
 * authenticated portal fetch keyed off related_flag_id.
 *
 * The category portion is resolved via `resolveCategoryLabel`, which
 * enforces a whitelist and falls back to "Clinical alert" for any
 * unexpected value (see `CATEGORY_LABELS`).
 */
function buildNotificationTitle(event: NotificationEvent, categoryLabel: string): string {
  const severityLabel = event.severity === "critical" ? "CRITICAL" : event.severity === "warning" ? "Warning" : "Info";
  return `${severityLabel}: Clinical flag — ${categoryLabel}`;
}

/**
 * Produce a lock-screen-safe rendering of the flag summary for push-layer
 * delivery. Returns a template string built from the whitelisted category
 * label alone; `event.summary` is intentionally discarded (it may contain
 * PHI such as patient identifiers or clinical numeric values like
 * "BP 145/95" or "K+ 7.2 mmol/L" that must not surface on a locked
 * device).
 *
 * The full summary is still persisted on `notifications.body` (encrypted
 * at rest) for authenticated portal render once the device is unlocked;
 * the value returned here is what a future APNs/FCM push integration
 * will hand to the OS, and it is also persisted on
 * `notifications.summary_safe` so later fetches can surface the safe
 * variant without re-deriving it.
 */
function buildSafeSummary(categoryLabel: string): string {
  // Trust nothing from the event.summary — always fall back to the
  // whitelisted category label (which itself guards against unknown values).
  return `Clinical flag — ${categoryLabel}. Open the portal to view details.`;
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
    log.info("No recipients found for flag", {
      flagId: event.flag_id,
      patient: redactPatientId(event.patient_id),
      specialties: event.notify_specialties,
    });
    return 0;
  }

  const categoryLabel = resolveCategoryLabel(event.category);
  const title = buildNotificationTitle(event, categoryLabel);
  const link = buildFlagLink(event);
  const now = new Date().toISOString();
  const urgent = isUrgentFlag(event.severity);
  const safeSummary = buildSafeSummary(categoryLabel);

  let immediateCount = 0;
  let delayedCount = 0;
  let skippedCount = 0;

  const immediateRecords: Array<{
    id: string;
    user_id: string;
    type: "ai-flag";
    title: string;
    body: string;
    summary_safe: string;
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
      log.info("Skipping notification — channel disabled", { userId });
      continue;
    }

    if (decision.delay_ms > 0) {
      // Re-queue the notification with a delay for this specific user.
      // We create a targeted delayed job rather than holding the current job.
      delayedCount++;
      log.info("Delaying notification (quiet hours)", {
        userId,
        delayMinutes: Math.round(decision.delay_ms / 60000),
      });
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
      summary_safe: safeSummary,
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
  //
  // Lock-screen safety — the published payload is what any future
  // push-notification integration (APNs/FCM) will hand to the OS. It
  // MUST NOT contain patient identifiers or clinical numeric values. We
  // replace `body` with the persisted `summary_safe` column (a generic
  // cue generated from category alone); the authenticated
  // clinician-portal fetch keyed off related_flag_id is responsible for
  // rendering full clinical detail once the device is unlocked. The DB
  // `body` (full summary) remains for that fetch.
  for (const record of immediateRecords) {
    try {
      await publishNotification(record.user_id, {
        id: record.id,
        type: record.type,
        title: record.title,
        body: record.summary_safe,
        link: record.link,
        related_flag_id: record.related_flag_id,
        is_urgent: record.is_urgent,
        created_at: record.created_at,
      });
    } catch (error) {
      log.error("Failed to publish notification to Redis", {
        notificationId: record.id,
        userId: record.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("Flag dispatch complete", {
    flagId: event.flag_id,
    severity: event.severity,
    immediateCount,
    delayedCount,
    skippedCount,
  });

  return immediateCount;
}

/**
 * Process a delayed single-user notification that was re-queued after quiet hours.
 */
async function processDelayedNotification(event: NotificationEvent & { _targeted_user_id: string }): Promise<number> {
  const db = getDb();
  const userId = event._targeted_user_id;
  const categoryLabel = resolveCategoryLabel(event.category);
  const title = buildNotificationTitle(event, categoryLabel);
  const link = buildFlagLink(event);
  const now = new Date().toISOString();

  const safeSummary = buildSafeSummary(categoryLabel);
  const record = {
    id: crypto.randomUUID(),
    user_id: userId,
    type: "ai-flag" as const,
    title,
    body: event.summary,
    summary_safe: safeSummary,
    link,
    related_flag_id: event.flag_id,
    is_urgent: isUrgentFlag(event.severity),
    is_read: false,
    created_at: now,
  };

  await db.insert(notifications).values(record);

  try {
    // Same lock-screen safety as the immediate path — publish the
    // PHI-free summary_safe rather than the persisted (encrypted) body.
    await publishNotification(record.user_id, {
      id: record.id,
      type: record.type,
      title: record.title,
      body: record.summary_safe,
      link: record.link,
      related_flag_id: record.related_flag_id,
      is_urgent: record.is_urgent,
      created_at: record.created_at,
    });
  } catch (error) {
    log.error("Failed to publish delayed notification to Redis", {
      notificationId: record.id,
      userId: record.user_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log.info("Delivered delayed notification", {
    notificationId: record.id,
    userId,
    flagId: event.flag_id,
  });

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

      log.info("Processing job", {
        jobId: job.id,
        flagId: event.flag_id,
        severity: event.severity,
        patient: redactPatientId(event.patient_id),
      });

      const startTime = Date.now();

      try {
        let count: number;

        if (job.name === "delayed-single" && event._targeted_user_id) {
          log.info("Processing delayed job", {
            jobId: job.id,
            flagId: event.flag_id,
            userId: event._targeted_user_id,
          });
          count = await processDelayedNotification(
            event as NotificationEvent & { _targeted_user_id: string },
          );
        } else {
          count = await processNotificationJob(event);
        }

        const elapsed = Date.now() - startTime;
        log.info("Job completed", {
          jobId: job.id,
          elapsedMs: elapsed,
          notificationsCreated: count,
        });
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        log.error("Job failed", {
          jobId: job.id,
          elapsedMs: elapsed,
          error: message,
        });
        throw error;
      }
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on("ready", () => {
    log.info("Worker ready", { queue: QUEUE_NAME });
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const isExhausted = attemptsMade >= maxAttempts;

    log.error("Job failed", {
      jobId: job?.id,
      attemptsMade,
      maxAttempts,
      error: error.message,
    });

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
        log.error("Failed to move job to DLQ", {
          jobId: job.id,
          error: msg,
        });
      });
    }
  });

  worker.on("error", (error: Error) => {
    log.error("Worker error", { error: error.message });
  });

  return worker;
}
