/**
 * Shared Redis connection configuration for BullMQ queues and workers.
 *
 * Reads from environment variables with sensible defaults for local development.
 */

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  tls?: Record<string, never>;
}

export function getRedisConnection(): RedisConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
  };
}

/**
 * BullMQ defaultJobOptions shared across every "clinical-events" publisher.
 *
 * Healthcare-critical: a Redis blip longer than the retry budget means the
 * event lands in the DLQ and the downstream AI oversight review may never
 * run. With 8 attempts and 2 s exponential backoff, the cumulative retry
 * window is ~4 minutes (2+4+8+16+32+64+128 s), which tolerates the 90 s
 * outage surfaced in issue #267 with generous margin.
 *
 * Exposing this as a shared constant keeps the clinical-events publishers
 * (api-gateway, clinical-data, clinical-notes, patient-records, and
 * messaging) in lockstep so future bumps can't drift.
 */
export const CLINICAL_EVENTS_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 10000 },
};
