import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB chain ------------------------------------------------------------
//
// After the issue #507 hardening the reconciler uses two chains:
//   update().set().where()                               — recover stale 'processing'
//   update().set().where().returning()                   — atomic claim
//   update().set().where()                               — mark terminal state per row
//
// The atomic claim is a single UPDATE...WHERE id IN (SELECT ... FOR UPDATE
// SKIP LOCKED) RETURNING *, which flips rows 'pending' -> 'processing' and
// returns the claimed batch in one statement. This is the fix for the
// "SKIP LOCKED lock held only for statement lifetime" problem: the UPDATE
// commits the claim before queue.add runs, so a crash between claim and
// enqueue leaves the row in 'processing' and the next tick's recovery pass
// flips it back to 'pending' for retry.

const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockReturning = vi.fn();

const mockDb = {
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
    updated_at: "updated_at",
    processed_at: "processed_at",
    error_message: "error_message",
  },
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
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
  RECONCILE_BATCH_SIZE,
  STALE_PROCESSING_THRESHOLD_MS,
} from "../workers/outbox-reconciler.js";

type ClaimedRow = {
  id: string;
  event_type: string;
  patient_id: string;
  event_payload: unknown;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string | null;
};

function makeRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
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
    ...overrides,
  };
}

/**
 * Wire the update() mock so that:
 *   call 1 → stale-'processing' recovery .where() resolves with undefined
 *   call 2 → atomic claim .where().returning() resolves with `claimedRows`
 *   call 3..N → per-row terminal-state update (.where()) resolves with undefined
 *
 * Each reconcileFailedEvents() invocation consumes (2 + claimedRows.length)
 * update calls. For concurrent-reconciler tests the queue of responses is
 * per-chain (mockReturning / mockUpdateWhere) and ordered by the call
 * site, so we enqueue responses for both invocations in interleaved order.
 */
function queueUpdateChain(
  claimedRows: ClaimedRow[],
  opts: { perRowUpdateResult?: Array<unknown> } = {},
) {
  // Recovery UPDATE .where() (no returning) -> resolved undefined
  mockUpdateWhere.mockResolvedValueOnce(undefined);
  // Atomic claim UPDATE .where().returning() -> claimedRows
  mockReturning.mockResolvedValueOnce(claimedRows);
  // Per-row terminal UPDATE .where() calls
  const perRow = opts.perRowUpdateResult ?? claimedRows.map(() => undefined);
  for (const r of perRow) {
    if (r instanceof Error) {
      mockUpdateWhere.mockRejectedValueOnce(r);
    } else {
      mockUpdateWhere.mockResolvedValueOnce(r);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();

  mockUpdate.mockReset();
  mockSet.mockReset();
  mockUpdateWhere.mockReset();
  mockReturning.mockReset();

  // Default chain: update().set().where() and update().set().where().returning()
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({
    where: (...args: unknown[]) => {
      // The .where() link is polymorphic: either terminal (awaited directly)
      // or followed by .returning(). We return an object that both (a) is
      // thenable via the mockUpdateWhere queue and (b) exposes .returning().
      const thenable = mockUpdateWhere(...args);
      return Object.assign(Promise.resolve(thenable).catch((e) => Promise.reject(e)), {
        returning: mockReturning,
      });
    },
  });

  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue(undefined);
});

describe("reconcileFailedEvents", () => {
  it("returns zero counts when no rows are claimed", async () => {
    queueUpdateChain([]);

    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 0, retried: 0, failed: 0 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("claims a pending row, re-emits it, and marks it processed", async () => {
    const row = makeRow();
    queueUpdateChain([row]);

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "medication.created",
      row.event_payload,
      { jobId: row.id },
    );

    // set() was called three times: recovery (processing->pending),
    // atomic claim (pending->processing), terminal (processing->processed).
    expect(mockSet).toHaveBeenCalledTimes(3);
    const terminalPayload = mockSet.mock.calls[2][0];
    expect(terminalPayload.status).toBe("processed");
    expect(terminalPayload.processed_at).toEqual(expect.any(String));
    expect(terminalPayload.updated_at).toEqual(expect.any(String));
  });

  it("increments retry_count and keeps status='pending' when re-emit fails below the cap", async () => {
    const row = makeRow({ retry_count: 1 });
    queueUpdateChain([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis still down"));

    const result = await reconcileFailedEvents();

    expect(result.reconciled).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);

    const terminalPayload = mockSet.mock.calls[2][0];
    expect(terminalPayload.status).toBe("pending");
    expect(terminalPayload.retry_count).toBe(2);
    expect(terminalPayload.error_message).toContain("Redis still down");
  });

  it("marks row status='failed' once retry_count reaches MAX_RECONCILE_RETRIES", async () => {
    const row = makeRow({ retry_count: MAX_RECONCILE_RETRIES - 1 });
    queueUpdateChain([row]);
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis persistently down"));

    const result = await reconcileFailedEvents();

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    const terminalPayload = mockSet.mock.calls[2][0];
    expect(terminalPayload.status).toBe("failed");
    expect(terminalPayload.retry_count).toBe(MAX_RECONCILE_RETRIES);
    expect(terminalPayload.processed_at).toEqual(expect.any(String));
  });

  it("processes multiple rows and tallies counts across outcomes", async () => {
    const ok = makeRow({ id: "o-1" });
    const retryable = makeRow({ id: "o-2", retry_count: 0 });
    const terminal = makeRow({ id: "o-3", retry_count: MAX_RECONCILE_RETRIES - 1 });
    queueUpdateChain([ok, retryable, terminal]);

    mockQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));

    const result = await reconcileFailedEvents();

    expect(result).toEqual({ reconciled: 1, retried: 1, failed: 1 });
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
  });

  // ── Idempotency + concurrency guards --------------------------------------

  it("passes jobId=row.id on queue.add so BullMQ dedupes the re-emit", async () => {
    const row = makeRow({ id: "outbox-race-1" });
    queueUpdateChain([row]);

    await reconcileFailedEvents();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0];
    expect(opts).toEqual({ jobId: "outbox-race-1" });
  });

  it("recovers rows stuck in status='processing' at the start of each tick with a time guard", async () => {
    // Rationale: a prior pod crashed between atomic claim and queue.add,
    // leaving a row pinned to 'processing'. The next tick's recovery pass
    // must reset these back to 'pending' so the row becomes claimable again.
    // The time guard (STALE_PROCESSING_THRESHOLD_MS) ensures only genuinely
    // stale rows are recovered — not in-flight rows from a concurrent pod.
    const row = makeRow({ id: "o-recovered" });
    queueUpdateChain([row]);

    await reconcileFailedEvents();

    // The *first* set() call in the tick is the recovery: processing -> pending
    // with an updated_at stamp so recovered rows aren't immediately re-recovered.
    expect(mockSet).toHaveBeenCalled();
    const recoveryPayload = mockSet.mock.calls[0][0];
    expect(recoveryPayload.status).toBe("pending");
    expect(recoveryPayload.updated_at).toEqual(expect.any(String));
    // Verify the STALE_PROCESSING_THRESHOLD_MS constant is exported and sensible
    expect(STALE_PROCESSING_THRESHOLD_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("atomic claim is a single UPDATE ... RETURNING — the row is persisted as 'processing' before queue.add runs", async () => {
    // This is the core of the #507 hardening: the claim and the status
    // transition to 'processing' happen in a single atomic statement, so
    // a crash between claim and queue.add cannot leave the row in 'pending'
    // (which would re-select on the next tick *before* BullMQ dedup had a
    // chance to notice the duplicate jobId).
    const row = makeRow({ id: "o-atomic" });
    queueUpdateChain([row]);

    // Track the order: the atomic-claim set() payload must set
    // status='processing', and it must happen before queue.add.
    const claimCallOrder: string[] = [];
    const origSet = mockSet.getMockImplementation();
    mockSet.mockImplementation((payload: { status?: string }) => {
      claimCallOrder.push(`set:${payload.status ?? "unknown"}`);
      return origSet
        ? origSet(payload)
        : { where: () => Promise.resolve(undefined) };
    });
    mockQueueAdd.mockImplementation(async () => {
      claimCallOrder.push("queue.add");
    });

    await reconcileFailedEvents();

    // Order: recovery (processing->pending), atomic claim (pending->processing),
    // queue.add, terminal (processing->processed)
    expect(claimCallOrder[0]).toBe("set:pending"); // recovery
    expect(claimCallOrder[1]).toBe("set:processing"); // atomic claim
    expect(claimCallOrder[2]).toBe("queue.add"); // emit
    expect(claimCallOrder[3]).toBe("set:processed"); // terminal
  });

  it("concurrent reconcilers claim disjoint batches (atomic UPDATE ... RETURNING guarantees mutual exclusion)", async () => {
    // Two pods tick at the same instant. Postgres' UPDATE...WHERE id IN
    // (SELECT ... FOR UPDATE SKIP LOCKED) guarantees that each row is
    // claimed by exactly one pod. Here we simulate that by giving each
    // invocation its own disjoint RETURNING result.
    const rowsForPodA = [makeRow({ id: "o-a1" }), makeRow({ id: "o-a2" })];
    const rowsForPodB = [makeRow({ id: "o-b1" })];

    // Wire both invocations in sequence. Each reconcileFailedEvents() call
    // consumes: 1 recovery .where(), 1 claim .returning(), N terminal .where()s.
    // Pod A: recovery, claim (2 rows), 2 terminal updates.
    // Pod B: recovery, claim (1 row), 1 terminal update.
    queueUpdateChain(rowsForPodA);
    queueUpdateChain(rowsForPodB);

    const [resultA, resultB] = await Promise.all([
      reconcileFailedEvents(),
      reconcileFailedEvents(),
    ]);

    const enqueuedIds = mockQueueAdd.mock.calls.map(
      (c) => (c[2] as { jobId: string }).jobId,
    );
    expect(new Set(enqueuedIds)).toEqual(
      new Set(["o-a1", "o-a2", "o-b1"]),
    );
    expect(enqueuedIds.length).toBe(3); // no duplicates
    expect(resultA.reconciled + resultB.reconciled).toBe(3);
  });

  it("limits the claim to RECONCILE_BATCH_SIZE rows", async () => {
    // The batch cap must be baked into the SQL. We assert the claim SQL
    // (.where() argument of the atomic claim UPDATE) carries the limit.
    queueUpdateChain([]);

    await reconcileFailedEvents();

    // The second .where() call is the atomic claim; its SQL fragment must
    // include the batch-size literal so a huge backlog cannot starve the
    // worker. We check via the SQL template by stringifying the argument.
    // (Drizzle's sql template returns an object; JSON.stringify-ish repr
    // should contain the batch-size number.)
    const claimWhereArg = mockUpdateWhere.mock.calls[1]?.[0];
    expect(claimWhereArg).toBeDefined();
    const repr = JSON.stringify(claimWhereArg);
    expect(repr).toContain(String(RECONCILE_BATCH_SIZE));
  });
});
