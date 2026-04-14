/**
 * Server-Sent Events endpoint for real-time notification delivery.
 *
 * Clients connect to GET /notifications/stream with their JWT in the
 * Authorization header or session cookie. The connection stays open and
 * pushes new notifications as they arrive via Redis Pub/Sub.
 *
 * Flow:
 * 1. Client connects → auth validated → Redis subscription created
 * 2. Notification dispatch worker publishes to Redis channel "notifications:{userId}"
 * 3. This SSE handler forwards the message to the connected client
 * 4. Client reconnects automatically on disconnect (EventSource spec)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import Redis from "ioredis";

function createSubscriberClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
  });
}

export function registerNotificationSSE(server: FastifyInstance): void {
  server.get(
    "/notifications/stream",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Extract user ID from the auth context (set by authMiddleware)
      const userId = (request as unknown as { userId?: string }).userId;

      if (!userId) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
      });

      // Send initial connection event
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ userId, timestamp: new Date().toISOString() })}\n\n`);

      // Create a dedicated Redis subscriber for this connection
      const subscriber = createSubscriberClient();
      const channel = `notifications:${userId}`;

      subscriber.subscribe(channel).catch((err: Error) => {
        console.error(`[sse] Failed to subscribe to ${channel}: ${err.message}`);
      });

      subscriber.on("message", (_ch: string, message: string) => {
        reply.raw.write(`event: notification\ndata: ${message}\n\n`);
      });

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, 30_000);

      // Clean up on disconnect
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
      });

      // Don't let Fastify close the reply — we're managing the stream
      await reply.hijack();
    },
  );
}
