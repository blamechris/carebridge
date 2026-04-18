/**
 * Shared clinical event emitter.
 *
 * Single source of truth for publishing clinical events to the BullMQ
 * "clinical-events" queue. If the primary emit fails (Redis down,
 * queue unreachable), the event is persisted to the outbox table via
 * {@link writeOutboxEntry} and later reconciled by the ai-oversight
 * outbox-reconciler worker.
 *
 * Both `@carebridge/clinical-data` and `@carebridge/clinical-notes`
 * previously defined byte-identical copies of this function. They now
 * depend on this module as the single source of truth.
 *
 * See: https://github.com/blamechris/carebridge/issues/817
 */

import { Queue } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { writeOutboxEntry } from "./index.js";

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
      await writeOutboxEntry(
        event,
        queueError instanceof Error ? queueError : String(queueError),
      );
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
