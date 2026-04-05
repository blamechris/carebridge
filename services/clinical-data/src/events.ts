import { Queue } from "bullmq";

export interface ClinicalEvent {
  type: string;
  resourceId: string;
  patientId: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

const connection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
};

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
});

export async function emitClinicalEvent(event: ClinicalEvent): Promise<void> {
  await clinicalEventsQueue.add(event.type, event);
}
