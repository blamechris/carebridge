/**
 * Fluent mock builder for Drizzle-style query chains in unit tests.
 *
 * Drizzle services write chains like:
 *   await db.select().from(t).where(eq(t.id, id)).limit(1);
 *   await db.update(t).set(x).where(eq(t.id, id)).returning();
 *   await db.insert(t).values(row);
 *
 * Testing these with hand-rolled `vi.fn().mockReturnValueOnce({...})` nests is
 * brittle: a harmless reorder of chain methods in prod code silently breaks
 * the test's fixture assumptions.
 *
 * This helper decouples *what a chain resolves to* from *which intermediate
 * chain methods were called*. Every chain-call method returns a chainable
 * thenable — you can stop chaining at any point and await. Results are queued
 * per root operation (`select` | `insert` | `update` | `delete`) and consumed
 * in FIFO order.
 *
 * Usage:
 *   const db = createMockDb()
 *     .willSelect([existingRow])   // 1st select chain resolves to [existingRow]
 *     .willInsert()                 // 1st insert chain resolves to undefined
 *     .willUpdate([{ id: "..." }]); // 1st update chain resolves to the rows
 *
 *   vi.mock("@carebridge/db-schema", () => ({ getDb: () => db, ... }));
 *
 * Assertions:
 *   expect(db.select).toHaveBeenCalledOnce();
 *   expect(db.insert).toHaveBeenCalledWith(tableRef);
 *   expect(db.update.calls[0]?.chain).toContain("set");
 */

import { vi, type Mock } from "vitest";

/** Root DB operations supported by the mock. */
export type MockDbOperation = "select" | "insert" | "update" | "delete";

/** Any value resolved from an awaited chain. `undefined` is allowed (e.g. insert().values()). */
export type MockDbResult = unknown;

/** Description of a single chain invocation recorded on the mock. */
export interface MockDbCallRecord {
  /** Which root operation was invoked (select/insert/update/delete). */
  operation: MockDbOperation;
  /** Arguments passed to the root method, e.g. `insert(patients)` → `[patients]`. */
  args: unknown[];
  /**
   * Ordered list of chain method names called after the root, e.g.
   * `["from", "where", "limit"]`.
   */
  chain: string[];
  /**
   * Ordered list of argument arrays passed to each chain method,
   * aligned with `chain` above.
   */
  chainArgs: unknown[][];
}

/** Root-level mock fn with extra call-record metadata. */
export interface RootOperationMock extends Mock {
  /** Call records for every invocation of this root operation. */
  calls: MockDbCallRecord[];
}

/**
 * The mock DB object passed to code under test. Matches the subset of the
 * Drizzle `getDb()` API used by CareBridge services.
 */
export interface MockDb {
  select: RootOperationMock;
  insert: RootOperationMock;
  update: RootOperationMock;
  delete: RootOperationMock;

  /** Queue a result for the next awaited chain of this operation. */
  queueResult(operation: MockDbOperation, result: MockDbResult): MockDb;

  /** Alias for `queueResult("select", rows)`. */
  willSelect(rows: MockDbResult): MockDb;

  /** Alias for `queueResult("insert", result)`. Defaults to `undefined`. */
  willInsert(result?: MockDbResult): MockDb;

  /** Alias for `queueResult("update", result)`. Defaults to `undefined`. */
  willUpdate(result?: MockDbResult): MockDb;

  /** Alias for `queueResult("delete", result)`. Defaults to `undefined`. */
  willDelete(result?: MockDbResult): MockDb;

  /**
   * Clear all queued results and recorded call history. Useful in
   * `beforeEach` when `vi.clearAllMocks()` alone isn't enough because results
   * are stored outside the vi.fn instances.
   */
  reset(): void;
}

/**
 * Build a thenable chain proxy for a given operation. Every chain method
 * (`from`, `where`, `limit`, etc.) returns the same proxy so chaining is
 * order-independent. When awaited, the proxy resolves to the next queued
 * result for the operation (or `undefined` if none queued).
 */
function createChainProxy(
  operation: MockDbOperation,
  record: MockDbCallRecord,
  resultsQueue: MockDbResult[],
): Record<string, unknown> {
  // Use a plain object we can assign dynamic properties to.
  const proxy: Record<string, unknown> = {};

  // Every chain method records the call and returns the same proxy.
  const chainMethod = (name: string) => {
    return (...args: unknown[]) => {
      record.chain.push(name);
      record.chainArgs.push(args);
      return proxy;
    };
  };

  // Known Drizzle chain verbs. Covers everything used by patient-records and
  // clinical-notes services today; add here (narrowly) if a future test needs
  // more.
  const chainNames = [
    "from",
    "where",
    "limit",
    "orderBy",
    "values",
    "set",
    "returning",
    "innerJoin",
    "leftJoin",
    "groupBy",
    "having",
    "offset",
  ] as const;

  for (const name of chainNames) {
    proxy[name] = chainMethod(name);
  }

  // Make the proxy thenable so `await proxy` resolves to the next queued
  // result for this operation. This lets prod code await mid-chain or at the
  // very end without the test caring.
  proxy.then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => {
    const next = resultsQueue.length > 0 ? resultsQueue.shift() : undefined;
    return Promise.resolve(next).then(onFulfilled, onRejected);
  };

  // Unused by current tests but keeps the object duck-typed as a Drizzle
  // builder for libraries that probe for `.catch`.
  proxy.catch = (onRejected?: (reason: unknown) => unknown) => {
    return Promise.resolve(undefined).catch(onRejected);
  };

  // Some Drizzle code paths call `.execute()` explicitly.
  proxy.execute = () => {
    const next = resultsQueue.length > 0 ? resultsQueue.shift() : undefined;
    return Promise.resolve(next);
  };

  return proxy;
}

/**
 * Build a root operation mock (`select` / `insert` / `update` / `delete`)
 * wired up to a chain proxy and a result queue.
 */
function createRootMock(
  operation: MockDbOperation,
  resultsQueue: MockDbResult[],
): RootOperationMock {
  const calls: MockDbCallRecord[] = [];

  const fn = vi.fn((...args: unknown[]) => {
    const record: MockDbCallRecord = {
      operation,
      args,
      chain: [],
      chainArgs: [],
    };
    calls.push(record);
    return createChainProxy(operation, record, resultsQueue);
  }) as RootOperationMock;

  // Attach the call-record metadata. `vi.fn()` also has a `mock.calls` array
  // for arg-based assertions — we keep that working too.
  Object.defineProperty(fn, "calls", {
    get: () => calls,
  });

  return fn;
}

/**
 * Build a fluent mock DB that chains Drizzle-style query methods in any
 * order. See the module docstring for a full usage example.
 */
export function createMockDb(): MockDb {
  const queues: Record<MockDbOperation, MockDbResult[]> = {
    select: [],
    insert: [],
    update: [],
    delete: [],
  };

  const selectMock = createRootMock("select", queues.select);
  const insertMock = createRootMock("insert", queues.insert);
  const updateMock = createRootMock("update", queues.update);
  const deleteMock = createRootMock("delete", queues.delete);

  const db: MockDb = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,

    queueResult(operation, result) {
      queues[operation].push(result);
      return db;
    },

    willSelect(rows) {
      queues.select.push(rows);
      return db;
    },

    willInsert(result) {
      queues.insert.push(result);
      return db;
    },

    willUpdate(result) {
      queues.update.push(result);
      return db;
    },

    willDelete(result) {
      queues.delete.push(result);
      return db;
    },

    reset() {
      queues.select.length = 0;
      queues.insert.length = 0;
      queues.update.length = 0;
      queues.delete.length = 0;
      selectMock.mockClear();
      insertMock.mockClear();
      updateMock.mockClear();
      deleteMock.mockClear();
      // Also reset our call-record arrays. They live in closures inside
      // createRootMock, so we just drop the root mocks' records by clearing
      // via the same `calls` references stored on the mock.
      selectMock.calls.length = 0;
      insertMock.calls.length = 0;
      updateMock.calls.length = 0;
      deleteMock.calls.length = 0;
    },
  };

  return db;
}
