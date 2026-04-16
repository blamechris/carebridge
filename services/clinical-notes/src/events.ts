import { Queue } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import { getDb, failedClinicalEvents } from "@carebridge/db-schema";
import type { ClinicalEvent } from "@carebridge/shared-types";

export type { ClinicalEvent };

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  try {
    await clinicalEventsQueue.add(event.type, event);
  } catch (queueError) {
    // Redis/BullMQ unavailable — persist to DB outbox for later retry
    try {
      const db = getDb();
      await db.insert(failedClinicalEvents).values({
        id: crypto.randomUUID(),
        event_type: event.type,
        patient_id: event.patient_id,
        event_payload: event,
        error_message: queueError instanceof Error ? queueError.message : String(queueError),
        status: "pending",
        retry_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (dbError) {
      // Both Redis and DB fallback failed — log critical error as last resort
      console.error(
        `[CRITICAL] Failed to emit clinical event and DB fallback also failed. ` +
        `Event type: ${event.type}, patient: ${event.patient_id}. ` +
        `Queue error: ${queueError instanceof Error ? queueError.message : String(queueError)}. ` +
        `DB error: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      );
    }
  }
}
