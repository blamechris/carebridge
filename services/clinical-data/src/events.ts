import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";

export interface ClinicalEvent {
  type: string;
  resourceId: string;
  patientId: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  await clinicalEventsQueue.add(event.type, event);
}
