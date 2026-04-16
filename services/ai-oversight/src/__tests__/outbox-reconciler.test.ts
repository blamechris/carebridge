import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB chain ------------------------------------------------------------
//
// The reconciler uses two chains:
//   select().from().where().for("update",{skipLocked}).limit()  — fetch + lock
//   update().set().where()                                      — mark row state
//
// We stub each link; the leaf call is the one whose resolved value we can
// configure per-test. The `.for(...)` link exists so concurrent reconcilers
// running on separate pods claim disjoint batches via Postgres
// `FOR UPDATE SKIP LOCKED` and do not both re-emit the same row.

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockFor = vi.fn();
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
  mockFor.mockReset();
  mockLimit.mockReset();

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelectWhere.mockReturnValue({ for: mockFor });
  mockFor.mockReturnValue({ limit: mockLimit });
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
      { jobId: row.id },
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

  // ── Idempotency + concurrency guards --------------------------------------

  it("passes jobId=row.id on queue.add so BullMQ dedupes the re-emit", async () => {
    // Addresses the queue.add + UPDATE race: if the add succeeds but the
    // status UPDATE fails, the row stays pending and the next tick will
    // re-select it. BullMQ must refuse a duplicate job for the same id.
    const row = makeRow({ id: "outbox-race-1" });
    mockSelectRows([row]);

    await reconcileFailedEvents();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0];
    expect(opts).toEqual({ jobId: "outbox-race-1" });
  });

  it("on partial failure (add resolves, UPDATE rejects) a second tick re-adds with the same jobId", async () => {
    // Partial-failure scenario from the review comment:
    //   1) tick A: queue.add succeeds, success-path UPDATE throws.
    //      The row does NOT get marked 'processed' — the code falls
    //      into the catch block and routes the row to the retry path
    //      (retry_count++, status stays 'pending'), so the row is
    //      selectable on the next tick.
    //   2) tick B: same row re-selected, queue.add called again.
    //
    // Invariant: both queue.add calls carry the same jobId (row.id)
    // so BullMQ dedupes the duplicate enqueue on the receiving side.
    // Without jobId dedup, review-service would produce a duplicate
    // clinical flag that a clinician would see.
    const row = makeRow({ id: "outbox-partial-1" });

    // Tick A: first UPDATE (success-path) rejects -> catch fires; the
    // catch's own UPDATE succeeds so reconcileFailedEvents returns
    // normally with the row counted as retried.
    mockSelectRows([row]);
    mockUpdateWhere
      .mockRejectedValueOnce(new Error("pool exhausted"))
      .mockResolvedValueOnce(undefined);

    const tickA = await reconcileFailedEvents();
    expect(tickA.reconciled).toBe(0);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][2]).toEqual({ jobId: "outbox-partial-1" });

    // Tick B: row re-selected (still 'pending' after the retry update),
    // UPDATE succeeds this time.
    mockSelectRows([row]);
    mockUpdateWhere.mockReset();
    mockUpdateWhere.mockResolvedValue(undefined);

    await reconcileFailedEvents();

    // Two enqueue attempts total, both carrying the same jobId so the
    // clinical-events queue dedupes on the receiving side.
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd.mock.calls[1][2]).toEqual({ jobId: "outbox-partial-1" });
  });

  it("uses FOR UPDATE SKIP LOCKED so concurrent reconcilers claim disjoint batches", async () => {
    // Simulates two reconcilers ticking at once. Postgres lock semantics
    // are enforced by the DB; here we assert the call shape — SKIP LOCKED
    // is requested — and that the mock behavior (each caller gets their
    // own set of rows) matches what the DB will do in prod.
    const rowsForPodA = [makeRow({ id: "o-a1" }), makeRow({ id: "o-a2" })];
    const rowsForPodB = [makeRow({ id: "o-b1" })];

    // Reset + wire the chain so two successive .limit() calls return
    // disjoint sets, mimicking two concurrent SKIP LOCKED claims.
    mockSelect.mockReset();
    mockFrom.mockReset();
    mockSelectWhere.mockReset();
    mockFor.mockReset();
    mockLimit.mockReset();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ for: mockFor });
    mockFor.mockReturnValue({ limit: mockLimit });
    mockLimit
      .mockResolvedValueOnce(rowsForPodA)
      .mockResolvedValueOnce(rowsForPodB);

    const [resultA, resultB] = await Promise.all([
      reconcileFailedEvents(),
      reconcileFailedEvents(),
    ]);

    // Both .for() invocations must request SKIP LOCKED so Postgres hands
    // out disjoint row sets instead of blocking one caller on the other.
    expect(mockFor).toHaveBeenCalledTimes(2);
    for (const call of mockFor.mock.calls) {
      expect(call[0]).toBe("update");
      expect(call[1]).toEqual({ skipLocked: true });
    }

    // Disjoint claim: the union of enqueued ids equals the union of
    // rows, with no duplicates across the two pods.
    const enqueuedIds = mockQueueAdd.mock.calls.map(
      (c) => (c[2] as { jobId: string }).jobId,
    );
    expect(new Set(enqueuedIds)).toEqual(
      new Set(["o-a1", "o-a2", "o-b1"]),
    );
    expect(enqueuedIds.length).toBe(3); // no duplicates
    expect(resultA.reconciled + resultB.reconciled).toBe(3);
  });
});
