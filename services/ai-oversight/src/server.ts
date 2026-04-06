/**
 * Entry point for the AI oversight worker process.
 *
 * Starts the BullMQ review worker and exposes a minimal HTTP health-check
 * endpoint so container orchestrators (k8s, ECS, etc.) can verify liveness.
 */

import { createServer } from "node:http";
import { startReviewWorker } from "./workers/review-worker.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 4001);

const worker = startReviewWorker();

const healthServer = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    const isHealthy = worker.isRunning() && !worker.isPaused();

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
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }),
    );
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

  console.log("[ai-oversight] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[ai-oversight] Unhandled rejection:", reason);
  process.exit(1);
});
