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
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  await clinicalEventsQueue.add(event.type, event);
}
