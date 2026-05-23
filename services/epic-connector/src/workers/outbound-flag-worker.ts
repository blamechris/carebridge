/**
 * BullMQ worker that pushes CareBridge flags to Epic (#393).
 *
 * Listens on the `epic-outbound-flags` queue. Each job carries:
 *   { type: "push-create",   flag_id }   — newly-created flag → POST
 *   { type: "push-status",   flag_id }   — status changed → PUT (or
 *                                          first-push if epic_flag_id
 *                                          isn't set yet)
 *
 * Both job types go through {@link pushFlagToEpic} which decides POST
 * vs PUT internally based on whether the row already has an
 * epic_flag_id.
 *
 * The worker is opt-in: `startEpicOutboundFlagWorker()` returns null
 * when Epic credentials aren't configured so local dev keeps booting.
 *
 * The enqueue helpers are also guarded — they no-op when Epic isn't
 * configured so callers (the ai-oversight flag-service) can call them
 * unconditionally and avoid duplicating the env-check at every site.
 */
import { Worker, Queue, type Job } from "bullmq";
import { createLogger } from "@carebridge/logger";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import { EpicFhirClient } from "../fhir-client.js";
import { EpicTokenClient } from "../token-client.js";
import { loadEpicConfig } from "../config.js";
import { pushFlagToEpic } from "../outbound/flag-push.js";

const log = createLogger("epic-outbound-flag-worker");

export const EPIC_OUTBOUND_FLAGS_QUEUE_NAME = "epic-outbound-flags";

export type EpicOutboundFlagJobData =
  | { type: "push-create"; flag_id: string }
  | { type: "push-status"; flag_id: string };

let queueSingleton: Queue<EpicOutboundFlagJobData> | null = null;

function getQueue(): Queue<EpicOutboundFlagJobData> {
  if (!queueSingleton) {
    queueSingleton = new Queue(EPIC_OUTBOUND_FLAGS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
    });
  }
  return queueSingleton;
}

/**
 * Returns true when Epic credentials are configured enough to attempt
 * outbound writes. Centralises the env check so callers don't all have
 * to remember which vars to check.
 */
export function isEpicOutboundEnabled(): boolean {
  return Boolean(process.env.EPIC_CLIENT_ID && process.env.EPIC_FHIR_BASE_URL);
}

/**
 * Enqueue a "newly-created flag → push" job. Safe to call when Epic
 * isn't configured — falls through as a no-op. Use jobId so a
 * duplicate-create from a retried flag-service write doesn't queue twice.
 */
export async function enqueueEpicFlagPushCreate(
  flagId: string,
): Promise<void> {
  if (!isEpicOutboundEnabled()) return;
  await getQueue().add(
    "push-create",
    { type: "push-create", flag_id: flagId },
    { jobId: `push-create:${flagId}` },
  );
}

/**
 * Enqueue a "flag status changed → propagate" job. Same idempotency
 * guarantees as {@link enqueueEpicFlagPushCreate}.
 */
export async function enqueueEpicFlagPushUpdate(
  flagId: string,
): Promise<void> {
  if (!isEpicOutboundEnabled()) return;
  await getQueue().add(
    "push-status",
    { type: "push-status", flag_id: flagId },
    {
      // jobId is per (flag, status-update-call) — repeated status
      // updates for the same flag DO need to enqueue distinct jobs,
      // unlike the create-push which dedupes on the flag id alone.
      // Add a timestamp suffix to break uniqueness.
      jobId: `push-status:${flagId}:${Date.now()}`,
    },
  );
}

/**
 * Start the Epic outbound-flag worker. Returns null when Epic isn't
 * configured (mirrors {@link startEpicSyncWorker}).
 */
export function startEpicOutboundFlagWorker(): Worker<EpicOutboundFlagJobData> | null {
  let config;
  try {
    config = loadEpicConfig();
  } catch (err) {
    log.info(
      "Epic outbound flag worker not started — credentials not configured",
      { reason: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
  const tokens = new EpicTokenClient(config);
  const client = new EpicFhirClient(config, tokens);

  const worker = new Worker<EpicOutboundFlagJobData>(
    EPIC_OUTBOUND_FLAGS_QUEUE_NAME,
    async (job: Job<EpicOutboundFlagJobData>) => {
      const start = Date.now();
      try {
        const result = await pushFlagToEpic(job.data.flag_id, { client });
        return result;
      } finally {
        log.info("Epic outbound flag job completed", {
          jobId: job.id,
          type: job.data.type,
          flag_id: job.data.flag_id,
          elapsed_ms: Date.now() - start,
        });
      }
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    log.error("Epic outbound flag job failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  return worker;
}
