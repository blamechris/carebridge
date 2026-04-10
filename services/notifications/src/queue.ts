/**
 * Notification event queue.
 *
 * Defines the notification event type and provides a queue for dispatching
 * notifications when clinical flags are created or other system events occur.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";

const QUEUE_NAME = "notifications";

const connection = getRedisConnection();

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
}

export const notificationsQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export async function emitNotificationEvent(
  event: NotificationEvent,
): Promise<void> {
  await notificationsQueue.add("flag-created", event);
}
