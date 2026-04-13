/**
 * Redis pub/sub publisher for real-time notification delivery via SSE.
 *
 * Publishes notification payloads to `notifications:{userId}` channels.
 * The SSE endpoint in api-gateway subscribes to these channels and forwards
 * messages to connected clients.
 */

import Redis from "ioredis";

export interface NotificationPayload {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  related_flag_id?: string;
  is_urgent?: boolean;
  created_at: string;
}

let publisherClient: Redis | null = null;

/**
 * Get (or create) the shared Redis publisher client.
 *
 * The client connects eagerly (no lazyConnect) so that publish calls
 * are sent immediately rather than buffered in an offline queue that
 * is never drained.
 */
export function getPublisher(): Redis {
  if (!publisherClient) {
    publisherClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
    });
  }
  return publisherClient;
}

/**
 * Replace the publisher instance (used by tests to inject a mock/spy).
 */
export function setPublisher(client: Redis): void {
  publisherClient = client;
}

/**
 * Publish a notification to the Redis channel for a specific user.
 *
 * The channel format `notifications:{userId}` matches what the SSE
 * endpoint in api-gateway subscribes to.
 */
export async function publishNotification(
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  if (!userId) return;
  const channel = `notifications:${userId}`;
  const publisher = getPublisher();
  await publisher.publish(channel, JSON.stringify(payload));
}
