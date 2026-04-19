/**
 * Notification event queue.
 *
 * Defines the notification event type and provides a queue for dispatching
 * notifications when clinical flags are created or other system events occur.
 */

import { Queue } from "bullmq";
import { getRedisConnection, DEFAULT_RETENTION_AGE_SECONDS } from "@carebridge/redis-config";

const QUEUE_NAME = "notifications";

const connection = getRedisConnection();

/**
 * Identifies who a notification is intended for.
 *
 * - `"providers"` (default): route via `care_team_assignments` → all active
 *   clinicians on the patient's care team, then filter by
 *   `notify_specialties` (the historical clinical-flag path).
 * - `"patient"`: deliver to the patient's own user row (looked up via
 *   `users.patient_id`). Used for patient-addressed notifications such as
 *   appointment reminders, secure messages from the care team, and
 *   "lab result available" pings — where care-team routing would be a
 *   HIPAA-adjacent misdelivery.
 *
 * Optional and defaulted server-side to `"providers"` so existing callers
 * (e.g. ai-oversight flag-service, escalation-worker) are unaffected.
 */
export type NotificationAudience = "patient" | "providers";

export interface NotificationEvent {
  flag_id: string;
  patient_id: string;
  severity: string;
  category: string;
  summary: string;
  suggested_action: string;
  notify_specialties: string[];
  source: string;
  created_at: string;
  /**
   * Who should receive this notification. Defaults to `"providers"` when
   * omitted to preserve the existing clinical-flag delivery path.
   */
  audience?: NotificationAudience;
}

export const notificationsQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: DEFAULT_RETENTION_AGE_SECONDS, count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export async function emitNotificationEvent(
  event: NotificationEvent,
): Promise<void> {
  await notificationsQueue.add("flag-created", event);
}
