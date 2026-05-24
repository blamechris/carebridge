/**
 * BullMQ worker that processes Epic sync jobs (#391).
 *
 * Listens on the "epic-sync" queue. Each job is one of:
 *   - { type: "full-sync",        patient_id, epic_patient_fhir_id? }
 *   - { type: "incremental-sync", patient_id, epic_patient_fhir_id? }
 *   - { type: "single-resource-sync", patient_id, epic_patient_fhir_id?,
 *       resource_type, watermark? }
 *
 * Production wiring expects `loadEpicConfig()` to succeed at startup —
 * if Epic credentials aren't configured, the host service should NOT
 * call `startEpicSyncWorker()`. Local dev environments without Epic
 * registration silently skip starting the worker so unrelated services
 * keep booting.
 */
import { Worker, Queue, type Job } from "bullmq";
import { createLogger } from "@carebridge/logger";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import { emitClinicalEvent } from "@carebridge/outbox";
import { EpicFhirClient } from "../fhir-client.js";
import { EpicTokenClient } from "../token-client.js";
import { loadEpicConfig } from "../config.js";
import {
  runFullSync,
  runIncrementalSync,
  runSingleResourceSync,
  type SyncResourceType,
  type SyncResult,
  type SkippedSubResource,
} from "../sync/sync-jobs.js";

const log = createLogger("epic-sync-worker");

export const EPIC_SYNC_QUEUE_NAME = "epic-sync";

export type EpicSyncJobData =
  | {
      type: "full-sync";
      patient_id: string;
      epic_patient_fhir_id?: string;
    }
  | {
      type: "incremental-sync";
      patient_id: string;
      epic_patient_fhir_id?: string;
    }
  | {
      type: "single-resource-sync";
      patient_id: string;
      epic_patient_fhir_id?: string;
      resource_type: SyncResourceType;
      watermark?: string | null;
    };

let queueSingleton: Queue<EpicSyncJobData> | null = null;

/**
 * Lazily-instantiated Epic-sync queue. Defer construction until first
 * use so importing this module from a host that ultimately decides NOT
 * to start the worker (e.g. local dev without Epic creds) doesn't
 * open an idle Redis connection.
 */
export function getEpicSyncQueue(): Queue<EpicSyncJobData> {
  if (!queueSingleton) {
    queueSingleton = new Queue(EPIC_SYNC_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
    });
  }
  return queueSingleton;
}

export async function enqueueFullSync(args: {
  patient_id: string;
  epic_patient_fhir_id?: string;
}): Promise<void> {
  await getEpicSyncQueue().add(
    "full-sync",
    { type: "full-sync", ...args },
    { jobId: `full-sync:${args.patient_id}` },
  );
}

export async function enqueueIncrementalSync(args: {
  patient_id: string;
  epic_patient_fhir_id?: string;
}): Promise<void> {
  await getEpicSyncQueue().add(
    "incremental-sync",
    { type: "incremental-sync", ...args },
    {
      // Coalesce overlapping incremental requests for the same patient.
      // BullMQ's jobId dedupe makes back-to-back triggers cheap.
      jobId: `incremental-sync:${args.patient_id}`,
    },
  );
}

export async function enqueueSingleResourceSync(args: {
  patient_id: string;
  resource_type: SyncResourceType;
  epic_patient_fhir_id?: string;
  watermark?: string | null;
}): Promise<void> {
  await getEpicSyncQueue().add(
    "single-resource-sync",
    { type: "single-resource-sync", ...args },
    {
      jobId: `single:${args.resource_type}:${args.patient_id}`,
    },
  );
}

/**
 * Start the Epic-sync BullMQ worker. Pulls Epic credentials from env
 * via `loadEpicConfig()` and wires the FHIR client + outbox emit into
 * the job runners. Returns the Worker handle so the host can wire
 * graceful-shutdown listeners.
 *
 * Returns null when Epic credentials are not configured — the host
 * service should treat this as "Epic integration is disabled" rather
 * than an error, so local dev keeps booting without registering with
 * Epic.
 */
export function startEpicSyncWorker(): Worker<EpicSyncJobData> | null {
  let config;
  try {
    config = loadEpicConfig();
  } catch (err) {
    log.info("Epic sync worker not started — credentials not configured", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const tokens = new EpicTokenClient(config);
  const client = new EpicFhirClient(config, tokens);

  const worker = new Worker<EpicSyncJobData>(
    EPIC_SYNC_QUEUE_NAME,
    async (job: Job<EpicSyncJobData>) => {
      const start = Date.now();
      try {
        if (job.data.type === "full-sync") {
          const results = await runFullSync(
            {
              patientId: job.data.patient_id,
              epicPatientFhirId: job.data.epic_patient_fhir_id,
            },
            { client, emit: emitClinicalEvent },
          );
          return summarise(results);
        }
        if (job.data.type === "incremental-sync") {
          const results = await runIncrementalSync(
            {
              patientId: job.data.patient_id,
              epicPatientFhirId: job.data.epic_patient_fhir_id,
            },
            { client, emit: emitClinicalEvent },
          );
          return summarise(results);
        }
        if (job.data.type === "single-resource-sync") {
          const result = await runSingleResourceSync(
            {
              patientId: job.data.patient_id,
              epicPatientFhirId: job.data.epic_patient_fhir_id,
              resourceType: job.data.resource_type,
              watermark: job.data.watermark ?? null,
            },
            { client, emit: emitClinicalEvent },
          );
          return summarise([result]);
        }
        // exhaustiveness guard
        const exhaustive: never = job.data;
        throw new Error(`Unknown job type: ${JSON.stringify(exhaustive)}`);
      } finally {
        const elapsed = Date.now() - start;
        log.info("Epic sync job completed", {
          jobId: job.id,
          type: job.data.type,
          elapsed_ms: elapsed,
        });
      }
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  worker.on("failed", (job, err) => {
    log.error("Epic sync job failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  return worker;
}

interface SyncSummary {
  imported: number;
  updated: number;
  conflicts: number;
  errors: number;
  /** Count of soft-skipped sub-resource fetches across all resource types (#1107). */
  skipped: number;
  /** Per-skip detail for ops dashboards that want structured drill-down (#1107). Capped at SUMMARISE_SKIPPED_DETAIL_CAP (#1120). */
  skippedDetail: SkippedSubResource[];
  /** How many skipped entries were dropped from skippedDetail due to the cap (#1120). 0 when nothing was truncated. */
  skippedDetailTruncated: number;
}

/**
 * Maximum entries in `summarise().skippedDetail` (#1120). The full
 * set is already persisted to `epic_sync_state.skipped_sub_resources`
 * via markOk/markFailed — operators have a recovery path via the DB
 * for the long tail. The cap protects the Redis-persisted BullMQ
 * job result payload from bloating as fan-out widens (e.g., the
 * future multi-status MedicationRequest fan-out under #1114).
 */
export const SUMMARISE_SKIPPED_DETAIL_CAP = 50;

/**
 * Rolls up a per-resource-type `SyncResult[]` into the single object
 * returned as the BullMQ job result and surfaced via `job.returnvalue`.
 *
 * `skipped` + `skippedDetail` (#1107) make sub-resource auth-scope
 * issues visible from the BullMQ dashboard without cross-referencing
 * the `epic_sync_state` Postgres column. `skippedDetail` is capped at
 * SUMMARISE_SKIPPED_DETAIL_CAP entries (#1120); overflow is reported
 * via `skippedDetailTruncated` so dashboards can render "+N more".
 *
 * Single-pass implementation (#1121) — avoids the O(N²) spread-in-reduce
 * pattern. Not measurable today with N ≤ 5 but matters as fan-out grows.
 *
 * Exported for unit testing — the worker callbacks invoke it directly.
 */
export function summarise(results: SyncResult[]): SyncSummary {
  let imported = 0;
  let updated = 0;
  let conflicts = 0;
  let errors = 0;
  let skipped = 0;
  const skippedDetail: SkippedSubResource[] = [];
  let skippedDetailTruncated = 0;

  for (const r of results) {
    imported += r.imported;
    updated += r.updated;
    conflicts += r.conflicts;
    errors += r.errors.length;
    skipped += r.skipped.length;
    for (const s of r.skipped) {
      if (skippedDetail.length < SUMMARISE_SKIPPED_DETAIL_CAP) {
        skippedDetail.push(s);
      } else {
        skippedDetailTruncated++;
      }
    }
  }

  return {
    imported,
    updated,
    conflicts,
    errors,
    skipped,
    skippedDetail,
    skippedDetailTruncated,
  };
}
