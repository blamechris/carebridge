import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

interface DeletedSessionRow {
  id: string;
  user_id: string;
  expires_at: string | null;
  last_active_at: string | null;
  created_at: string;
}

let db: MockDb;

// Tracks records inserted via `db.insert(auditLog).values({...})`. Populated
// in `beforeEach` by wiring up a spy on the helper's insert chain.
const insertedAuditEntries: Array<Record<string, unknown>> = [];

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  sessions: {
    id: "sessions.id",
    user_id: "sessions.user_id",
    expires_at: "sessions.expires_at",
    created_at: "sessions.created_at",
    last_active_at: "sessions.last_active_at",
  },
  auditLog: {
    id: "audit_log.id",
  },
}));

vi.mock("drizzle-orm", () => ({
  lt: (col: string, val: string) => ({ op: "lt", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNotNull: (col: string) => ({ op: "isNotNull", col }),
  sql: () => ({}),
}));

const { cleanupExpiredSessions } = await import("../session-cleanup.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function seedDeletedRow(
  overrides: Partial<DeletedSessionRow> = {},
): DeletedSessionRow {
  return {
    id: overrides.id ?? "s1",
    user_id: overrides.user_id ?? "user-1",
    expires_at: overrides.expires_at ?? new Date(Date.now() + 3_600_000).toISOString(),
    last_active_at: overrides.last_active_at ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

/**
 * Extract the argument passed to the `where()` chain call on the delete
 * operation (equivalent to the legacy `mockWhere.mock.calls[0][0]` check).
 */
function getDeleteWhereArg(): { op: string; args: unknown[] } {
  const call = db.delete.calls[0];
  if (!call) throw new Error("expected db.delete to have been called");
  const whereIdx = call.chain.indexOf("where");
  return call.chainArgs[whereIdx]?.[0] as { op: string; args: unknown[] };
}

describe("cleanupExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    insertedAuditEntries.length = 0;

    // The helper's insert chain does not retain what was passed to
    // `.values(...)` except inside chainArgs. Each test seeds its own
    // deleted-row fixture via `db.willDelete`; audit-log assertions read
    // the `values(...)` args directly from `db.insert.calls[i].chainArgs`.
  });

  it("calls db.delete on the sessions table", async () => {
    db.willDelete([]);
    const count = await cleanupExpiredSessions();

    expect(db.delete).toHaveBeenCalledTimes(1);
    const deleteChain = db.delete.calls[0]?.chain ?? [];
    expect(deleteChain).toContain("where");
    expect(deleteChain).toContain("returning");
    expect(count).toBe(0);
  });

  it("returns the number of deleted rows", async () => {
    db.willDelete([
      seedDeletedRow({ id: "s1" }),
      seedDeletedRow({ id: "s2" }),
      seedDeletedRow({ id: "s3" }),
    ]);

    const count = await cleanupExpiredSessions();

    expect(count).toBe(3);
  });

  it("builds an OR condition covering expiry, idle, and hard-cap", async () => {
    db.willDelete([]);
    await cleanupExpiredSessions();

    const whereArg = getDeleteWhereArg();

    // Top-level should be an OR with three branches.
    expect(whereArg.op).toBe("or");
    expect(whereArg.args).toHaveLength(3);

    // First branch: lt(expires_at, ...)
    const expiryCondition = whereArg.args[0] as { op: string; col: string };
    expect(expiryCondition.op).toBe("lt");
    expect(expiryCondition.col).toBe("sessions.expires_at");

    // Second branch: and(isNotNull(last_active_at), lt(last_active_at, ...))
    const idleCondition = whereArg.args[1] as {
      op: string;
      args: unknown[];
    };
    expect(idleCondition.op).toBe("and");
    expect(idleCondition.args).toHaveLength(2);

    // Third branch: lt(created_at, ...)
    const hardCapCondition = whereArg.args[2] as { op: string; col: string };
    expect(hardCapCondition.op).toBe("lt");
    expect(hardCapCondition.col).toBe("sessions.created_at");
  });

  it("uses correct idle timeout of 15 minutes", async () => {
    db.willDelete([]);
    const before = Date.now();
    await cleanupExpiredSessions();
    const after = Date.now();

    const whereArg = getDeleteWhereArg();

    const idleCondition = whereArg.args[1] as {
      op: string;
      args: { op: string; col: string; val: string }[];
    };
    const idleThreshold = new Date(idleCondition.args[1].val).getTime();
    const fifteenMinutes = 15 * 60 * 1000;

    // The threshold should be approximately now - 15 minutes.
    expect(idleThreshold).toBeGreaterThanOrEqual(before - fifteenMinutes - 100);
    expect(idleThreshold).toBeLessThanOrEqual(after - fifteenMinutes + 100);
  });

  it("uses correct hard cap of 48 hours", async () => {
    db.willDelete([]);
    const before = Date.now();
    await cleanupExpiredSessions();
    const after = Date.now();

    const whereArg = getDeleteWhereArg() as {
      op: string;
      args: { op: string; val: string }[];
    };

    const hardCapThreshold = new Date(whereArg.args[2].val).getTime();
    const fortyEightHours = 48 * 60 * 60 * 1000;

    expect(hardCapThreshold).toBeGreaterThanOrEqual(before - fortyEightHours - 100);
    expect(hardCapThreshold).toBeLessThanOrEqual(after - fortyEightHours + 100);
  });

  it("logs when sessions are deleted", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    db.willDelete([seedDeletedRow({ id: "s1" })]);

    await cleanupExpiredSessions();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 1 expired/idle sessions"),
    );
    consoleSpy.mockRestore();
  });

  it("writes a session_idle_expired audit entry for each deleted session", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const idlePast = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const oldCreated = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

    db.willDelete([
      seedDeletedRow({
        id: "expired-1",
        user_id: "user-a",
        expires_at: pastExpiry,
      }),
      seedDeletedRow({
        id: "idle-1",
        user_id: "user-b",
        last_active_at: idlePast,
      }),
      seedDeletedRow({
        id: "hard-cap-1",
        user_id: "user-c",
        created_at: oldCreated,
      }),
    ]);

    await cleanupExpiredSessions();

    // Each `db.insert(auditLog).values({...})` is recorded on the helper.
    // Extract the values argument of each call.
    const entries = db.insert.calls.map((call) => {
      const valuesIdx = call.chain.indexOf("values");
      return call.chainArgs[valuesIdx]?.[0] as Record<string, unknown>;
    });

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.action).toBe("session_idle_expired");
      expect(entry.resource_type).toBe("session");
      expect(typeof entry.resource_id).toBe("string");
      expect(typeof entry.user_id).toBe("string");
      const details = JSON.parse(entry.details as string);
      expect(typeof details.reason).toBe("string");
      expect(details.reason.length).toBeGreaterThan(0);
    }

    const byId = Object.fromEntries(entries.map((e) => [e.resource_id, e]));
    expect(JSON.parse(byId["expired-1"].details as string).reason).toContain(
      "Absolute",
    );
    expect(JSON.parse(byId["hard-cap-1"].details as string).reason).toContain(
      "Hard-cap",
    );
    expect(JSON.parse(byId["idle-1"].details as string).reason).toContain(
      "Idle",
    );

    consoleSpy.mockRestore();
  });

  it("does not log when no sessions are deleted", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    db.willDelete([]);

    await cleanupExpiredSessions();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
