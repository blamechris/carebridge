import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import type { ClinicalEvent } from "@carebridge/shared-types";

export type { ClinicalEvent };

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  await clinicalEventsQueue.add(event.type, event);
}
