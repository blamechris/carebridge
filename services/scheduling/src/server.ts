/**
 * Scheduling worker entrypoint (#984).
 *
 * Starts the BullMQ reminder worker so jobs enqueued by `scheduleReminders`
 * are actually drained. Exposes a minimal `/health` endpoint for orchestrators
 * to verify liveness alongside Redis reachability.
 */

import { createServer } from "node:http";
import { createLogger } from "@carebridge/logger";
import { startReminderWorker } from "./workers/reminder-worker.js";

const log = createLogger("scheduling");

const HEALTH_PORT = Number(process.env.SCHEDULING_HEALTH_PORT ?? 4003);

const worker = startReminderWorker();

const REDIS_PING_TIMEOUT_MS = 2_000;

async function checkRedis(): Promise<"connected" | "disconnected"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const client = await worker.client;
    const result = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          REDIS_PING_TIMEOUT_MS,
        );
      }),
    ]);
    return result === "PONG" ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  } finally {
    // Cancel the timeout when ping resolves first so we don't leak a
    // 2-second pending timer (and an unhandled-rejection) per /health hit.
    if (timer) clearTimeout(timer);
  }
}

const healthServer = createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    const redis = await checkRedis();
    const workerOk = worker.isRunning() && !worker.isPaused();
    const isHealthy = workerOk && redis === "connected";
    res.writeHead(isHealthy ? 200 : 503, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        status: isHealthy ? "healthy" : "unhealthy",
        service: "scheduling-worker",
        worker: { running: worker.isRunning(), paused: worker.isPaused() },
        redis,
        timestamp: new Date().toISOString(),
      }),
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log.info(`Health check listening on port ${HEALTH_PORT}`);
});

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down…`);
  healthServer.close();
  await worker.close();
  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
