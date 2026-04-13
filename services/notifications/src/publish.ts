/**
 * Redis pub/sub publisher for real-time notification delivery via SSE.
 *
 * Publishes notification payloads to `notifications:{userId}` channels.
 * The SSE endpoint in api-gateway subscribes to these channels and forwards
 * messages to connected clients.
 */

import Redis from "ioredis";
import { getRedisConnection } from "@carebridge/redis-config";

export interface NotificationPayload {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  related_flag_id?: string;
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
    publisherClient = new Redis(getRedisConnection());
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
 * Gracefully close the Redis publisher connection if one exists.
 *
 * After calling this the singleton is cleared so a subsequent
 * `getPublisher()` call will create a fresh connection.
 */
export async function shutdownPublisher(): Promise<void> {
  if (publisherClient) {
    await publisherClient.quit();
    publisherClient = null;
  }
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
