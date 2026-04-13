import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { getDb, failedClinicalEvents } from "@carebridge/db-schema";
import type { ClinicalEvent } from "@carebridge/shared-types";

export type { ClinicalEvent };

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

/**
 * Persists a failed clinical event to the database so it can be retried later.
 * This is the fallback when Redis/BullMQ is unavailable.
 */
async function persistFailedEvent(
  event: ClinicalEvent,
  error: unknown,
): Promise<void> {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  try {
    const db = getDb();
    await db.insert(failedClinicalEvents).values({
      id: crypto.randomUUID(),
      event_type: event.type,
      event_payload: event as unknown as Record<string, unknown>,
      error_message: errorMessage,
      status: "pending",
      retry_count: 0,
      created_at: new Date().toISOString(),
    });
  } catch (dbError) {
    // Last resort: log to stderr so ops can see it in container logs
    console.error(
      "[CRITICAL] Failed to persist clinical event to fallback table",
      {
        event,
        originalError: errorMessage,
        dbError: dbError instanceof Error ? dbError.message : String(dbError),
      },
    );
  }
}

/**
 * Emits a clinical event to the BullMQ queue for AI oversight processing.
 *
 * On Redis/BullMQ failure the event is written to the `failed_clinical_events`
 * PostgreSQL table so it can be retried later. The error is never propagated
 * to the caller — the parent clinical data mutation must succeed even when the
 * event pipeline is temporarily unavailable.
 */
export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  try {
    await clinicalEventsQueue.add(event.type, event);
  } catch (error) {
    console.error("[EVENT_EMISSION_FAILED] Clinical event could not be queued", {
      eventId: event.id,
      eventType: event.type,
      patientId: event.patient_id,
      error: error instanceof Error ? error.message : String(error),
    });

    await persistFailedEvent(event, error);
  }
}
