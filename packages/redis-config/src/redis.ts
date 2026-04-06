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
