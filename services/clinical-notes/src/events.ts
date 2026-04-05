import { Queue } from "bullmq";

export interface ClinicalEvent {
  type: string;
  noteId: string;
  patientId: string;
  providerId: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

const clinicalEventsQueue = new Queue("clinical-events", {
  connection: { host: "localhost", port: 6379 },
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  await clinicalEventsQueue.add(event.type, event);
}
