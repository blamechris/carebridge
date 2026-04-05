import { Queue } from "bullmq";
import type { ClinicalEvent, ClinicalEventType } from "@carebridge/shared-types";

export type { ClinicalEvent };

const connection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
};

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
});

export async function emitClinicalEvent(params: {
  type: ClinicalEventType;
  noteId: string;
  patient_id: string;
  provider_id: string;
  timestamp: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const event: ClinicalEvent = {
    id: crypto.randomUUID(),
    type: params.type,
    patient_id: params.patient_id,
    provider_id: params.provider_id,
    data: { noteId: params.noteId, ...params.data },
    timestamp: params.timestamp,
  };

  await clinicalEventsQueue.add(event.type, event);
}
