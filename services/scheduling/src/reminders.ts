/**
 * Appointment reminder scheduling (issue #333).
 *
 * Hooks into the appointments lifecycle: when an appointment is booked we
 * push two delayed BullMQ jobs (24 h and 2 h before start_time) onto the
 * `appointment-reminders` queue. When the appointment is cancelled we call
 * `job.remove()` on both to prevent reminders for a cancelled slot.
 *
 * Architecture (issue #333 Option A):
 *   A dedicated queue and worker live here rather than mixing delayed jobs
 *   into the existing `notifications` queue. When a reminder fires, the
 *   worker assembles a lock-screen-safe `NotificationEvent` and hands it to
 *   the existing notifications dispatch chain via `emitNotificationEvent` —
 *   which then owns actual delivery (DB write, channel routing, encryption,
 *   preference checks).
 *
 * Storage (issue #333 Option X):
 *   BullMQ job IDs are persisted on the `appointments` row itself
 *   (`reminder_24h_job_id`, `reminder_2h_job_id`). Two fixed offsets → no
 *   need for a separate `appointment_reminders` table.
 *
 * PHI safety:
 *   The reminder-worker builds a PHI-free `summary_safe` from a static
 *   template. The full `summary` may include provider name / date / time;
 *   it is encrypted at rest by the notifications chain.
 */

import { Queue } from "bullmq";
import {
  getRedisConnection,
  DEFAULT_RETENTION_AGE_SECONDS,
} from "@carebridge/redis-config";

export const REMINDERS_QUEUE_NAME = "appointment-reminders";

/** Reminder offsets in milliseconds, applied to `appointment.start_time`. */
export const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
export const REMINDER_2H_MS = 2 * 60 * 60 * 1000;

const connection = getRedisConnection();

/**
 * Dedicated queue for delayed appointment reminder jobs.
 *
 * Kept separate from the `notifications` queue (which is for immediate
 * dispatch of clinical flags) so operators can observe and tune these
 * workloads independently.
 */
export const appointmentRemindersQueue = new Queue(REMINDERS_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: DEFAULT_RETENTION_AGE_SECONDS, count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/** Job payload for an appointment reminder. */
export interface AppointmentReminderJob {
  appointment_id: string;
  user_id: string; // patient user id (notification recipient)
  type: "reminder_24h" | "reminder_2h";
}

/** Subset of the `appointments` row required to schedule reminders. */
export interface AppointmentLike {
  id: string;
  patient_id: string;
  start_time: string; // ISO-8601
}

/** Result of a schedule call — nullable when the offset is in the past. */
export interface ScheduledReminderIds {
  reminder_24h_job_id: string | null;
  reminder_2h_job_id: string | null;
}

/**
 * Schedule the 24 h-before and 2 h-before reminder jobs for an appointment.
 *
 * Skips any offset whose delay is <= 0 (appointment is in the past or within
 * the offset window). Returns the job IDs so the caller can persist them on
 * the appointment row for later cancellation.
 *
 * BullMQ resolves `queue.add(..., { delay })` to a `Job` whose `id` is
 * auto-generated; we read that `id` back to store on the row.
 */
export async function scheduleReminders(
  appointment: AppointmentLike,
  now: Date = new Date(),
): Promise<ScheduledReminderIds> {
  const startMs = Date.parse(appointment.start_time);
  // Guard against invalid ISO strings — don't throw, reminders are best-effort.
  if (Number.isNaN(startMs)) {
    return { reminder_24h_job_id: null, reminder_2h_job_id: null };
  }

  const nowMs = now.getTime();
  const delay24h = startMs - REMINDER_24H_MS - nowMs;
  const delay2h = startMs - REMINDER_2H_MS - nowMs;

  const result: ScheduledReminderIds = {
    reminder_24h_job_id: null,
    reminder_2h_job_id: null,
  };

  if (delay24h > 0) {
    const job = await appointmentRemindersQueue.add(
      "reminder_24h",
      {
        appointment_id: appointment.id,
        user_id: appointment.patient_id,
        type: "reminder_24h",
      } satisfies AppointmentReminderJob,
      { delay: delay24h },
    );
    result.reminder_24h_job_id = job.id ?? null;
  }

  if (delay2h > 0) {
    const job = await appointmentRemindersQueue.add(
      "reminder_2h",
      {
        appointment_id: appointment.id,
        user_id: appointment.patient_id,
        type: "reminder_2h",
      } satisfies AppointmentReminderJob,
      { delay: delay2h },
    );
    result.reminder_2h_job_id = job.id ?? null;
  }

  return result;
}

/**
 * Best-effort cancellation of any scheduled reminder jobs for an
 * appointment.
 *
 * Idempotent: null inputs are no-ops, and BullMQ `getJob()` + `remove()`
 * is safe when a job has already fired or been cleaned up — we swallow
 * errors because a cancelled appointment should never block on a reminder
 * cleanup failure.
 */
export async function cancelReminders(
  jobIds: {
    reminder_24h_job_id: string | null | undefined;
    reminder_2h_job_id: string | null | undefined;
  },
): Promise<void> {
  const ids = [
    jobIds.reminder_24h_job_id ?? null,
    jobIds.reminder_2h_job_id ?? null,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);

  for (const id of ids) {
    try {
      const job = await appointmentRemindersQueue.getJob(id);
      if (job) {
        await job.remove();
      }
    } catch {
      // `job.remove()` throws when the job is currently locked (active) or
      // already gone. Either way, there's nothing the caller can do; the
      // reminder worker itself double-checks appointment status before
      // emitting a notification, so a stale job firing is defensively
      // handled downstream.
    }
  }
}
