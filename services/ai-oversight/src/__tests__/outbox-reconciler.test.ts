import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB chain ------------------------------------------------------------
//
// The reconciler uses three chains:
//   select().from().where().limit()  — fetch pending rows
//   update().set().where()             — mark a row processed / failed / retried
//
// We stub each link; the leaf call is the one whose resolved value we can
// configure per-test.

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockLimit = vi.fn();

const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();

const mockDb = {
  select: mockSelect,
  update: mockUpdate,
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  failedClinicalEvents: {
    id: "id",
    event_type: "event_type",
    patient_id: "patient_id",
    event_payload: "event_payload",
    status: "status",
    retry_count: "retry_count",
    created_at: "created_at",
    processed_at: "processed_at",
    error_message: "error_message",
  },
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  CLINICAL_EVENTS_JOB_OPTIONS: {
    attempts: 8,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: { count: 1000 },
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
  RECONCILE_BATCH_SIZE,
} from "../workers/outbox-reconciler.js";

type PendingRow = {
  id: string;
  event_type: string;
  patient_id: string;
  event_payload: unknown;
  status: string;
  retry_count: number;
  created_at: string;
};

function makeRow(overrides: Partial<PendingRow> = {}): PendingRow {
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
    status: "pending",
    retry_count: 0,
    created_at: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

function mockSelectRows(rows: PendingRow[]) {
  mockSelect.mockReset();
  mockFrom.mockReset();
  mockSelectWhere.mockReset();
  mockLimit.mockReset();

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelectWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();

  mockUpdate.mockReset();
  mockSet.mockReset();
  mockUpdateWhere.mockReset();
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);

  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
});

describe("reconcileFailedEvents", () => {
  it("returns zero counts when no pending events", async () => {
    mockSelectRows([]);

    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 0, retried: 0, failed: 0 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("re-emits pending events to the clinical-events queue and marks them processed", async () => {
    const row = makeRow();
    mockSelectRows([row]);

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "medication.created",
      row.event_payload,
    );

    expect(mockSet).toHaveBeenCalledTimes(1);
    const payload = mockSet.mock.calls[0][0];
    expect(payload.status).toBe("processed");
    expect(payload.processed_at).toEqual(expect.any(String));
  });

  it("increments retry_count and keeps status='pending' when re-emit fails below the cap", async () => {
    const row = makeRow({ retry_count: 1 });
    mockSelectRows([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis still down"));

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);

    const payload = mockSet.mock.calls[0][0];
    expect(payload.status).toBe("pending");
    expect(payload.retry_count).toBe(2);
    expect(payload.error_message).toContain("Redis still down");
  });

  it("marks row status='failed' once retry_count reaches MAX_RECONCILE_RETRIES", async () => {
    const row = makeRow({ retry_count: MAX_RECONCILE_RETRIES - 1 });
    mockSelectRows([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis persistently down"));

    const result = await reconcileFailedEvents();

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    const payload = mockSet.mock.calls[0][0];
    expect(payload.status).toBe("failed");
    expect(payload.retry_count).toBe(MAX_RECONCILE_RETRIES);
    expect(payload.processed_at).toEqual(expect.any(String));
  });

  it("processes multiple rows and tallies counts across outcomes", async () => {
    const ok = makeRow({ id: "o-1" });
    const retryable = makeRow({ id: "o-2", retry_count: 0 });
    const terminal = makeRow({ id: "o-3", retry_count: MAX_RECONCILE_RETRIES - 1 });
    mockSelectRows([ok, retryable, terminal]);

    // ok: success on first add; retryable + terminal: rejected
    mockQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));

    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 1, retried: 1, failed: 1 });
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });

  it("limits the batch size so a huge backlog doesn't starve the worker", async () => {
    mockSelectRows([]);
    await reconcileFailedEvents();
    expect(mockLimit).toHaveBeenCalledWith(RECONCILE_BATCH_SIZE);
  });
});
