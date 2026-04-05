/**
 * Entrypoint for the AI oversight worker process.
 *
 * Starts the BullMQ review worker that consumes from the "clinical-events"
 * queue and runs each event through deterministic rules + LLM review.
 */

import { startReviewWorker } from "./workers/review-worker.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

function main(): void {
  console.info("[ai-oversight] Starting AI oversight worker...");
  console.info(`[ai-oversight] Redis connection: ${REDIS_HOST}:${REDIS_PORT}`);
  console.info(
    `[ai-oversight] Redis auth: ${REDIS_PASSWORD ? "enabled" : "disabled"}`,
  );
  console.info(`[ai-oversight] Started at ${new Date().toISOString()}`);

  const worker = startReviewWorker();

  const shutdown = async (signal: string): Promise<void> => {
    console.info(
      `[ai-oversight] Received ${signal}, shutting down gracefully...`,
    );

    try {
      await worker.close();
      console.info("[ai-oversight] Worker closed successfully.");
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ai-oversight] Error during shutdown: ${message}`);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main();
