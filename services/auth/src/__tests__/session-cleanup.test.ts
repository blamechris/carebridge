import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const deletedRows: { id: string }[] = [];
const mockReturning = vi.fn(() => deletedRows);
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockDeleteFn = vi.fn(() => ({ where: mockWhere }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ delete: mockDeleteFn }),
  sessions: {
    id: "sessions.id",
    user_id: "sessions.user_id",
    expires_at: "sessions.expires_at",
    created_at: "sessions.created_at",
    last_active_at: "sessions.last_active_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  lt: (col: string, val: string) => ({ op: "lt", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNotNull: (col: string) => ({ op: "isNotNull", col }),
  sql: () => ({}),
}));

import { cleanupExpiredSessions } from "../session-cleanup.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deletedRows.length = 0;
  });

  it("calls db.delete on the sessions table", async () => {
    const count = await cleanupExpiredSessions();

    expect(mockDeleteFn).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockReturning).toHaveBeenCalledTimes(1);
    expect(count).toBe(0);
  });

  it("returns the number of deleted rows", async () => {
    deletedRows.push({ id: "s1" }, { id: "s2" }, { id: "s3" });

    const count = await cleanupExpiredSessions();

    expect(count).toBe(3);
  });

  it("builds an OR condition covering expiry, idle, and hard-cap", async () => {
    await cleanupExpiredSessions();

    const whereArg = mockWhere.mock.calls[0]![0] as {
      op: string;
      args: unknown[];
    };

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
    const before = Date.now();
    await cleanupExpiredSessions();
    const after = Date.now();

    const whereArg = mockWhere.mock.calls[0]![0] as {
      op: string;
      args: unknown[];
    };

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
    const before = Date.now();
    await cleanupExpiredSessions();
    const after = Date.now();

    const whereArg = mockWhere.mock.calls[0]![0] as {
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
    deletedRows.push({ id: "s1" });

    await cleanupExpiredSessions();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deleted 1 expired/idle sessions"),
    );
    consoleSpy.mockRestore();
  });

  it("does not log when no sessions are deleted", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cleanupExpiredSessions();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
