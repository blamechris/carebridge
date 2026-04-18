import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @carebridge/outbox ─────────────────────────────────────
const {
  mockRecoverStaleProcessing,
  mockReadPendingBatch,
  mockMarkProcessed,
  mockMarkRetry,
  mockMarkFailed,
} = vi.hoisted(() => ({
  mockRecoverStaleProcessing: vi.fn().mockResolvedValue(undefined),
  mockReadPendingBatch: vi.fn().mockResolvedValue([]),
  mockMarkProcessed: vi.fn().mockResolvedValue(undefined),
  mockMarkRetry: vi.fn().mockResolvedValue(undefined),
  mockMarkFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@carebridge/outbox", () => ({
  recoverStaleProcessing: mockRecoverStaleProcessing,
  readPendingBatch: mockReadPendingBatch,
  markProcessed: mockMarkProcessed,
  markRetry: mockMarkRetry,
  markFailed: mockMarkFailed,
  MAX_RECONCILE_RETRIES: 5,
  RECONCILE_BATCH_SIZE: 100,
  STALE_PROCESSING_THRESHOLD_MS: 5 * 60 * 1000,
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  DEFAULT_RETENTION_AGE_SECONDS: 600,
  CLINICAL_EVENTS_JOB_OPTIONS: {
    attempts: 8,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: { age: 600, count: 1000 },
    removeOnFail: { count: 10000 },
  },
}));

const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    add = mockQueueAdd;
  },
  Worker: class MockWorker {
    on = vi.fn();
  },
}));

import {
  reconcileFailedEvents,
  MAX_RECONCILE_RETRIES,
  STALE_PROCESSING_THRESHOLD_MS,
} from "../workers/outbox-reconciler.js";

type OutboxRow = {
  id: string;
  event_type: string;
  patient_id: string;
  event_payload: unknown;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string | null;
  processed_at: string | null;
  error_message: string | null;
};

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "outbox-1",
    event_type: "medication.created",
    patient_id: "pat-1",
    event_payload: {
      id: "evt-1",
      type: "medication.created",
      patient_id: "pat-1",
      timestamp: "2026-04-16T00:00:00.000Z",
      data: { resourceId: "med-1" },
    },
    status: "processing",
    retry_count: 0,
    created_at: "2026-04-16T00:00:00.000Z",
    updated_at: null,
    processed_at: null,
    error_message: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
  mockReadPendingBatch.mockResolvedValue([]);
});

describe("reconcileFailedEvents", () => {
  it("returns zero counts when no rows are claimed", async () => {
    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 0, retried: 0, failed: 0 });
    expect(mockRecoverStaleProcessing).toHaveBeenCalledOnce();
    expect(mockReadPendingBatch).toHaveBeenCalledOnce();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("claims a pending row, re-emits it, and marks it processed", async () => {
    const row = makeRow();
    mockReadPendingBatch.mockResolvedValueOnce([row]);

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "medication.created",
      row.event_payload,
      { jobId: row.id },
    );
    expect(mockMarkProcessed).toHaveBeenCalledWith(row.id);
  });

  it("calls markRetry when re-emit fails below the cap", async () => {
    const row = makeRow({ retry_count: 1 });
    mockReadPendingBatch.mockResolvedValueOnce([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis still down"));

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);

    expect(mockMarkRetry).toHaveBeenCalledWith(row.id, expect.any(Error));
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("calls markFailed once retry_count reaches MAX_RECONCILE_RETRIES", async () => {
    const row = makeRow({ retry_count: MAX_RECONCILE_RETRIES - 1 });
    mockReadPendingBatch.mockResolvedValueOnce([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis persistently down"));

    const result = await reconcileFailedEvents();

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    expect(mockMarkFailed).toHaveBeenCalledWith(row.id, expect.any(Error));
    expect(mockMarkRetry).not.toHaveBeenCalled();
  });

  it("processes multiple rows and tallies counts across outcomes", async () => {
    const ok = makeRow({ id: "o-1" });
    const retryable = makeRow({ id: "o-2", retry_count: 0 });
    const terminal = makeRow({ id: "o-3", retry_count: MAX_RECONCILE_RETRIES - 1 });
    mockReadPendingBatch.mockResolvedValueOnce([ok, retryable, terminal]);

    mockQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));

    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 1, retried: 1, failed: 1 });
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
  });

  it("passes jobId=row.id on queue.add so BullMQ dedupes the re-emit", async () => {
    const row = makeRow({ id: "outbox-race-1" });
    mockReadPendingBatch.mockResolvedValueOnce([row]);

    await reconcileFailedEvents();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0];
    expect(opts).toEqual({ jobId: "outbox-race-1" });
  });

  it("recovers stale processing rows at the start of each tick", async () => {
    await reconcileFailedEvents();

    expect(mockRecoverStaleProcessing).toHaveBeenCalledOnce();
    // Verify the constant is re-exported and sensible
    expect(STALE_PROCESSING_THRESHOLD_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("calls recoverStaleProcessing before readPendingBatch", async () => {
    const callOrder: string[] = [];
    mockRecoverStaleProcessing.mockImplementationOnce(async () => {
      callOrder.push("recover");
    });
    mockReadPendingBatch.mockImplementationOnce(async () => {
      callOrder.push("claim");
      return [];
    });

    await reconcileFailedEvents();

    expect(callOrder).toEqual(["recover", "claim"]);
  });
});
