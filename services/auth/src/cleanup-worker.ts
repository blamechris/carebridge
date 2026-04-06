import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import { cleanupExpiredSessions } from "./session-cleanup.js";

const QUEUE_NAME = "session-cleanup";

/**
 * Start the session-cleanup BullMQ worker and enqueue a repeatable hourly job.
 *
 * Call this once at auth-service startup.
 */
export async function startCleanupWorker(): Promise<{
  queue: Queue;
  worker: Worker;
}> {
  const connection = getRedisConnection();

  const queue = new Queue(QUEUE_NAME, { connection });

  // Add a repeatable job that fires at the top of every hour.
  await queue.upsertJobScheduler(
    "session-cleanup-hourly",
    { pattern: "0 * * * *" },
    { name: "cleanup", data: {} },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await cleanupExpiredSessions();
      return { deletedCount: count };
    },
    { connection },
  );

  worker.on("completed", (job, result) => {
    console.log(
      `[session-cleanup] Job ${job?.id} completed — deleted ${(result as { deletedCount: number }).deletedCount} sessions`,
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[session-cleanup] Job ${job?.id} failed:`,
      err.message,
    );
  });

  console.log("[session-cleanup] Worker started (hourly schedule)");

  return { queue, worker };
}
