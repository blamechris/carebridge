/**
 * BullMQ worker for the `appointment-reminders` queue (issue #333).
 *
 * When a delayed reminder job fires the worker:
 *   1. Loads the appointment row by ID.
 *   2. Skips if the row is missing (appointment was deleted — graceful
 *      no-op per the "Safety rigor" bullet in the issue).
 *   3. Skips if the appointment has been cancelled (status === "cancelled")
 *      — belt-and-suspenders for the rare race where `cancelReminders`
 *      couldn't remove a job that had already entered the active state.
 *   4. Loads the provider's display name (best-effort; falls back to
 *      "your provider" if missing).
 *   5. Hands a `NotificationEvent` to `emitNotificationEvent` — the
 *      existing notifications dispatch chain then owns actual delivery,
 *      preference evaluation, DB write (with PHI encryption), and Redis
 *      pub/sub to the SSE endpoint.
 *
 * PHI safety:
 *   `summary` MAY contain provider name + time (encrypted at rest by the
 *   notifications chain), but `summary_safe` is the lock-screen-safe
 *   payload that a future APNs/FCM integration would surface on a locked
 *   device. We build `summary_safe` from a static template that contains
 *   NO patient name, provider name, diagnosis, or MRN.
 */

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { getDb } from "@carebridge/db-schema";
import { appointments, users } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import { createLogger } from "@carebridge/logger";
import { getRedisConnection } from "@carebridge/redis-config";
import {
  emitNotificationEvent,
  type NotificationEvent,
} from "@carebridge/notifications";
import {
  REMINDERS_QUEUE_NAME,
  type AppointmentReminderJob,
} from "../reminders.js";

const log = createLogger("reminder-worker");

/**
 * Lock-screen-safe summary shown on push notifications. MUST NOT contain
 * patient identifiers, provider names, diagnosis codes, or appointment
 * times. The authenticated portal fetch (keyed off `appointment_id` via
 * `related_flag_id`) is responsible for rendering detail once the device
 * is unlocked.
 */
const SAFE_SUMMARY = "You have an upcoming appointment. Open the portal for details.";

/**
 * Render the full (encrypted-at-rest) summary text. May contain PHI —
 * never surfaces on a lock screen.
 */
export function buildReminderSummary(opts: {
  type: "reminder_24h" | "reminder_2h";
  providerName: string;
  startTime: string; // ISO-8601
  location: string | null;
  reason: string | null;
}): string {
  const when = opts.type === "reminder_24h" ? "tomorrow" : "in 2 hours";
  const timeLabel = formatClockTime(opts.startTime);
  const locationLabel = opts.location ? ` at ${opts.location}` : "";
  const prep = opts.reason ? ` Reason: ${opts.reason}.` : "";
  return (
    `Reminder: You have an appointment with ${opts.providerName} ${when}` +
    ` at ${timeLabel}${locationLabel}.${prep}`
  );
}

/**
 * Render an ISO timestamp as a human-friendly clock time (UTC).
 * e.g. "2026-04-17T14:30:00.000Z" → "2:30 PM UTC".
 *
 * We deliberately render in UTC so the worker's output is deterministic
 * across deployment timezones; front-ends can later re-render in the
 * recipient's locale once the notification is fetched.
 */
export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = minutes.toString().padStart(2, "0");
  return `${hours}:${mm} ${suffix} UTC`;
}

/**
 * Process a single reminder job. Exported for unit testing.
 */
export async function processReminderJob(
  payload: AppointmentReminderJob,
): Promise<"emitted" | "skipped_missing" | "skipped_cancelled"> {
  const db = getDb();

  const [appointment] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, payload.appointment_id));

  if (!appointment) {
    log.warn("Reminder fired for missing appointment — skipping", {
      appointmentId: payload.appointment_id,
      type: payload.type,
    });
    return "skipped_missing";
  }

  if (appointment.status === "cancelled") {
    log.info("Reminder fired for cancelled appointment — skipping", {
      appointmentId: payload.appointment_id,
      type: payload.type,
    });
    return "skipped_cancelled";
  }

  // Provider name lookup — best-effort. If the row is gone or has no name
  // column populated we still emit the reminder with a generic label.
  let providerName = "your provider";
  try {
    const [provider] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, appointment.provider_id));
    if (provider?.name) providerName = provider.name;
  } catch (error) {
    log.warn("Provider lookup failed — using fallback label", {
      providerId: appointment.provider_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const summary = buildReminderSummary({
    type: payload.type,
    providerName,
    startTime: appointment.start_time,
    location: appointment.location,
    reason: appointment.reason,
  });

  // Piggy-back on the existing `NotificationEvent` shape so the dispatch
  // chain's PHI encryption / preferences / SSE logic all apply unchanged.
  //
  // - `category: "patient-reported"` is the closest whitelisted category
  //   for a patient-addressed message (see CATEGORY_LABELS in
  //   notifications/workers/dispatch-worker.ts). Using a non-whitelisted
  //   value would fall back to "Clinical alert" on the lock screen.
  // - `flag_id` carries the appointment ID so the patient portal can deep
  //   link to the appointment record via the existing `related_flag_id`
  //   column.
  const event: NotificationEvent = {
    flag_id: appointment.id,
    patient_id: appointment.patient_id,
    severity: "info",
    category: "patient-reported",
    summary, // full PHI, encrypted at rest by the notifications chain
    suggested_action: SAFE_SUMMARY,
    notify_specialties: [],
    source: "scheduling.reminder",
    created_at: new Date().toISOString(),
  };

  await emitNotificationEvent(event);

  log.info("Emitted appointment reminder notification", {
    appointmentId: appointment.id,
    type: payload.type,
  });

  return "emitted";
}

/**
 * Start the appointment-reminders BullMQ worker.
 */
export function startReminderWorker(): Worker {
  const worker = new Worker(
    REMINDERS_QUEUE_NAME,
    async (job: Job<AppointmentReminderJob>) => {
      const payload = job.data;
      log.info("Processing reminder job", {
        jobId: job.id,
        appointmentId: payload.appointment_id,
        type: payload.type,
      });

      try {
        const outcome = await processReminderJob(payload);
        log.info("Reminder job complete", {
          jobId: job.id,
          appointmentId: payload.appointment_id,
          outcome,
        });
      } catch (error) {
        log.error("Reminder job failed", {
          jobId: job.id,
          appointmentId: payload.appointment_id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("ready", () => {
    log.info("Reminder worker ready", { queue: REMINDERS_QUEUE_NAME });
  });

  worker.on("error", (error: Error) => {
    log.error("Reminder worker error", { error: error.message });
  });

  return worker;
}
