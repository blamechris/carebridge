import { startCleanupWorker } from "@carebridge/auth";

/**
 * Handles for background workers started at gateway boot.
 *
 * Holding references prevents the BullMQ workers from being garbage-collected
 * and gives the caller a way to gracefully shut them down.
 */
export interface BackgroundWorkerHandles {
  sessionCleanup: Awaited<ReturnType<typeof startCleanupWorker>>;
}

/**
 * Start all background workers that the API gateway is responsible for.
 *
 * Currently:
 *  - Session cleanup worker (HIPAA § 164.312(a)(2)(i) — enforces the
 *    15-minute idle timeout and 48-hour hard cap defined in
 *    services/auth/src/session-cleanup.ts).
 *
 * Call once at server startup, after Redis configuration is available.
 */
export async function startBackgroundWorkers(): Promise<BackgroundWorkerHandles> {
  const sessionCleanup = await startCleanupWorker();

  return { sessionCleanup };
}
