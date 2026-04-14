/**
 * BullMQ worker that processes clinical events through the AI oversight pipeline.
 *
 * This worker listens on the "clinical-events" queue (the same queue that
 * clinical-data and clinical-notes services publish to) and runs each event
 * through the full review pipeline: deterministic rules first, then LLM review.
 */

import { Worker, Queue } from "bullmq";
import type { Job } from "bullmq";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { getRedisConnection } from "@carebridge/redis-config";
import { redactPatientId } from "@carebridge/phi-sanitizer";
import { processReviewJob } from "../services/review-service.js";

const QUEUE_NAME = "clinical-events";
const DLQ_NAME = "clinical-events-failed";

const connection = getRedisConnection();

const dlq = new Queue(DLQ_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

/**
 * Create and start the clinical events review worker.
 */
export function startReviewWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const event = job.data as ClinicalEvent;

      console.log(
        `[review-worker] Processing job ${job.id} — event: ${event.type} ` +
          `for patient ${redactPatientId(event.patient_id)}`,
      );

      const startTime = Date.now();

      try {
        await processReviewJob(event);

        const elapsed = Date.now() - startTime;
        console.log(
          `[review-worker] Job ${job.id} completed in ${elapsed}ms`,
        );
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `[review-worker] Job ${job.id} failed after ${elapsed}ms: ${message}`,
        );
        throw error; // Re-throw so BullMQ marks it as failed and can retry
      }
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 60_000, // Max 10 jobs per minute to respect API rate limits
      },
    },
  );

  worker.on("ready", () => {
    console.log(
      `[review-worker] Worker ready, listening on queue "${QUEUE_NAME}"`,
    );
  });

  worker.on("failed", (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    const isExhausted = attemptsMade >= maxAttempts;

    console.error(
      `[review-worker] Job ${job?.id} failed (attempt ${attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    if (isExhausted && job != null) {
      const dlqPayload = {
        originalJobId: job.id,
        originalQueue: QUEUE_NAME,
        jobData: job.data as ClinicalEvent,
        failedAt: new Date().toISOString(),
        finalError: error.message,
        attemptsMade,
      };

      dlq.add("dead-letter", dlqPayload).catch((dlqError: unknown) => {
        const msg =
          dlqError instanceof Error ? dlqError.message : String(dlqError);
        console.error(
          `[review-worker] Failed to move job ${job.id} to DLQ: ${msg}`,
        );
      });
    }
  });

  worker.on("error", (error) => {
    console.error(`[review-worker] Worker error: ${error.message}`);
  });

  return worker;
}
