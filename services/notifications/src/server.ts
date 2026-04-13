/**
 * Notification dispatch worker entry point.
 *
 * Starts the BullMQ notification dispatch worker and exposes a health check
 * endpoint for monitoring.
 */

import { createServer } from "node:http";
import { startDispatchWorker } from "./workers/dispatch-worker.js";
import { shutdownPublisher } from "./publish.js";

const HEALTH_PORT = Number(process.env.NOTIFICATION_HEALTH_PORT ?? 4002);

const worker = startDispatchWorker();

const REDIS_PING_TIMEOUT_MS = 2_000;

async function checkRedis(): Promise<"connected" | "disconnected"> {
  try {
    const client = await worker.client;
    const result = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), REDIS_PING_TIMEOUT_MS),
      ),
    ]);
    return result === "PONG" ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

const healthServer = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    const redis = await checkRedis();
    const status = redis === "connected" ? 200 : 503;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: redis === "connected" ? "ok" : "degraded",
      service: "notifications-worker",
      redis,
      timestamp: new Date().toISOString(),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[notifications] Health check listening on port ${HEALTH_PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[notifications] Received ${signal}, shutting down…`);
  healthServer.close();
  await worker.close();
  await shutdownPublisher();
  console.log("[notifications] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
