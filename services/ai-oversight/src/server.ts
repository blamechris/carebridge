/**
 * Entry point for the AI oversight worker process.
 *
 * Starts the BullMQ review worker and exposes a minimal HTTP health-check
 * endpoint so container orchestrators (k8s, ECS, etc.) can verify liveness.
 */

import { createServer } from "node:http";
import { startReviewWorker } from "./workers/review-worker.js";
import { setupEscalationQueue, startEscalationWorker } from "./workers/escalation-worker.js";
import { formatPrometheus, getMetricsSnapshot } from "./services/shadow-metrics.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 4001);

const worker = startReviewWorker();
const escalationQueue = setupEscalationQueue();
const escalationWorker = startEscalationWorker();

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

const healthServer = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    checkRedis()
      .then((redisStatus) => {
        const workerOk = worker.isRunning() && !worker.isPaused();
        const redisOk = redisStatus === "connected";
        const isHealthy = workerOk && redisOk;

        res.writeHead(isHealthy ? 200 : 503, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            status: isHealthy ? "healthy" : "unhealthy",
            worker: {
              running: worker.isRunning(),
              paused: worker.isPaused(),
            },
            redis: redisStatus,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          }),
        );
      })
      .catch(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "unhealthy",
            redis: "disconnected",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          }),
        );
      });
  } else if (req.url === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(formatPrometheus(getMetricsSnapshot()));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[ai-oversight] Health check listening on port ${HEALTH_PORT}`);
});

// Graceful shutdown -----------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`[ai-oversight] Received ${signal}, shutting down…`);

  healthServer.close();
  await worker.close();
  await escalationWorker.close();
  await escalationQueue.close();

  console.log("[ai-oversight] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[ai-oversight] Unhandled rejection:", reason);
  process.exit(1);
});
