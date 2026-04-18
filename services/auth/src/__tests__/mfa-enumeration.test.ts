import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

// In-memory Redis store so the router's pending MFA session lookup is
// controllable per-test.
const redisStore = new Map<string, { value: string; expiresAt: number }>();

vi.mock("ioredis", () => {
  class MockRedis {
    async get(key: string): Promise<string | null> {
      const entry = redisStore.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        redisStore.delete(key);
        return null;
      }
      return entry.value;
    }

    async set(
      key: string,
      value: string,
      _mode?: string,
      ttl?: number,
    ): Promise<"OK"> {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : Infinity;
      redisStore.set(key, { value, expiresAt });
      return "OK";
    }

    async del(...keys: string[]): Promise<number> {
      let deleted = 0;
      for (const key of keys) {
        if (redisStore.delete(key)) deleted++;
      }
      return deleted;
    }

    async exists(key: string): Promise<number> {
      const entry = redisStore.get(key);
      if (!entry) return 0;
      if (Date.now() >= entry.expiresAt) {
        redisStore.delete(key);
        return 0;
      }
      return 1;
    }

    async keys(pattern: string): Promise<string[]> {
      const prefix = pattern.replace("*", "");
      const now = Date.now();
      const result: string[] = [];
      for (const [k, v] of redisStore) {
        if (k.startsWith(prefix) && now < v.expiresAt) {
          result.push(k);
        }
      }
      return result;
    }
  }

  return { default: MockRedis };
});

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({
    host: "localhost",
    port: 6379,
    password: undefined,
    tls: undefined,
  }),
}));

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  users: {
    id: "users.id",
    email: "users.email",
    mfa_enabled: "users.mfa_enabled",
    mfa_secret: "users.mfa_secret",
    recovery_codes: "users.recovery_codes",
  },
  sessions: {
    id: "sessions.id",
    user_id: "sessions.user_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  gt: (col: string, val: unknown) => ({ op: "gt", col, val }),
  asc: (col: string) => ({ op: "asc", col }),
  inArray: (col: string, vals: unknown[]) => ({ op: "inArray", col, vals }),
}));

// Ensure JWT_SECRET is set for router import (not actually exercised in this
// test, but the module reads it during helper initialisation).
process.env.JWT_SECRET = "test-jwt-secret";
process.env.SESSION_SECRET = "test-session-secret";

// ---------------------------------------------------------------------------
// Import module under test (after all mocks are registered)
// ---------------------------------------------------------------------------

const { authRouter } = await import("../router.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MFA_SESSION_KEY_PREFIX = "mfa:session:";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function setPendingSessionInRedis(sessionId: string, userId: string) {
  redisStore.set(`${MFA_SESSION_KEY_PREFIX}${sessionId}`, {
    value: JSON.stringify({ userId }),
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

function createCaller() {
  return authRouter.createCaller({
    db: {} as never,
    user: null,
    sessionId: null,
    requestId: "test-request",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mfaCompleteLogin — user enumeration hardening (issue #278)", () => {
  beforeEach(() => {
    redisStore.clear();
    vi.clearAllMocks();
    db = createMockDb();
  });

  async function callAndCaptureError(): Promise<TRPCError> {
    try {
      await createCaller().mfaCompleteLogin({
        mfaSessionId: VALID_UUID,
        code: "123456",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      return err as TRPCError;
    }
    throw new Error("expected mfaCompleteLogin to throw");
  }

  it("returns a generic error when the MFA session is expired/missing", async () => {
    // No pending MFA session in Redis → router hits the "not found" branch.
    const err = await callAndCaptureError();
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe(
      "Invalid or expired MFA challenge. Please log in again.",
    );
  });

  it("returns the SAME generic error when the pending session references a deleted user", async () => {
    // Pending session exists, but the user row has been deleted.
    setPendingSessionInRedis(VALID_UUID, "deleted-user-id");
    db.willSelect([]); // db returns no rows

    const err = await callAndCaptureError();
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe(
      "Invalid or expired MFA challenge. Please log in again.",
    );
  });

  it("produces identical error code and message for both branches (no enumeration channel)", async () => {
    // Branch 1: expired MFA session.
    const expiredErr = await callAndCaptureError();

    // Branch 2: valid MFA session but deleted user.
    setPendingSessionInRedis(VALID_UUID, "deleted-user-id");
    db.willSelect([]);
    const deletedUserErr = await callAndCaptureError();

    expect(deletedUserErr.code).toBe(expiredErr.code);
    expect(deletedUserErr.message).toBe(expiredErr.message);
  });
});
