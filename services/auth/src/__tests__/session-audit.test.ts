import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

// In-memory sessions table (list of rows)
interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_active_at?: string | null;
  refresh_token?: string | null;
}

const sessionsStore: SessionRow[] = [];
const usersStore: Array<{
  id: string;
  email: string;
  name: string;
  role: string;
  specialty: string | null;
  department: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  password_hash: string;
  mfa_enabled: boolean;
}> = [];

const insertedAuditEntries: Array<Record<string, unknown>> = [];

// Chainable fluent query builder
function selectBuilder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  // Allow awaiting the chain directly (some code paths do)
  (chain as unknown as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve);
  return chain;
}

// Predicate matchers for our fake where(): we record the most recent predicate.
let lastPredicate: unknown = null;

const mockDb = {
  select: vi.fn((_shape?: unknown) => {
    // Decide which table is being queried by inspecting the next .from() call.
    // We'll stash a holder and resolve in .from().
    const holder: Record<string, unknown> = {};
    holder.from = vi.fn((table: unknown) => {
      const rows =
        table === "SESSIONS_TABLE"
          ? [...sessionsStore]
          : table === "USERS_TABLE"
            ? [...usersStore]
            : [];
      // Build a nested chain that supports .where().limit() or .where().orderBy()
      const nested: Record<string, unknown> = {};
      let filtered = rows;
      nested.where = vi.fn((_pred: unknown) => {
        lastPredicate = _pred;
        // No filtering — tests seed the store to exactly the expected rows.
        return nested;
      });
      nested.orderBy = vi.fn(() => nested);
      nested.limit = vi.fn(() => Promise.resolve(filtered));
      (nested as unknown as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => Promise.resolve(filtered).then(resolve);
      return nested;
    });
    return holder;
  }),
  insert: vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      if (table === "AUDIT_LOG_TABLE") {
        insertedAuditEntries.push(values);
      } else if (table === "SESSIONS_TABLE") {
        sessionsStore.push(values as unknown as SessionRow);
      }
      // Support .catch() — return a promise
      const p = Promise.resolve();
      return p;
    }),
  })),
  delete: vi.fn((_table: unknown) => ({
    where: vi.fn((_pred: unknown) => {
      // Clear matching sessions: tests use seeds where all rows are "matching"
      // for the delete call. We remove everything from sessionsStore.
      const removed = sessionsStore.splice(0, sessionsStore.length);
      const obj = {
        returning: vi.fn(() =>
          Promise.resolve(removed.map((r) => ({ id: r.id }))),
        ),
      };
      // Also callable as a promise directly
      (obj as unknown as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => Promise.resolve().then(resolve);
      return obj;
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  users: "USERS_TABLE",
  sessions: "SESSIONS_TABLE",
  auditLog: "AUDIT_LOG_TABLE",
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  asc: (col: unknown) => ({ op: "asc", col }),
  inArray: (col: unknown, values: unknown) => ({ op: "inArray", col, values }),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({ host: "localhost", port: 6379 }),
}));

vi.mock("ioredis", () => ({
  default: class MockRedis {
    async set() {
      return "OK";
    }
    async get() {
      return null;
    }
    async del() {
      return 1;
    }
  },
}));

vi.mock("../jwt.js", () => ({
  signJWT: async () => "signed.jwt.token",
}));

vi.mock("../password.js", () => ({
  hashPassword: async (pw: string) => `hashed:${pw}`,
  verifyPassword: async (pw: string, hash: string) => hash === `hashed:${pw}`,
}));

// Import router AFTER mocks are set up.
import { authRouter } from "../router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores() {
  sessionsStore.length = 0;
  usersStore.length = 0;
  insertedAuditEntries.length = 0;
  lastPredicate = null;
}

function makeUser(id: string = "user-1") {
  return {
    id,
    email: `${id}@carebridge.dev`,
    name: `User ${id}`,
    role: "physician",
    specialty: null,
    department: null,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    password_hash: "hashed:password123",
    mfa_enabled: false,
  };
}

function makeCtx(userId: string | null, sessionId: string | null = null) {
  return {
    db: mockDb as unknown as ReturnType<typeof import("@carebridge/db-schema").getDb>,
    user: userId
      ? ({
          id: userId,
          email: `${userId}@carebridge.dev`,
          name: `User ${userId}`,
          role: "physician",
          is_active: true,
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
        } as unknown as import("@carebridge/shared-types").User)
      : null,
    sessionId,
    requestId: "req-1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session lifecycle audit events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  describe("auth.logout", () => {
    it("writes a session_logout audit entry when a session is deleted", async () => {
      usersStore.push(makeUser("user-1"));
      sessionsStore.push({
        id: "sess-to-logout",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
      });

      const caller = authRouter.createCaller(makeCtx("user-1", "sess-to-logout"));
      const result = await caller.logout();

      expect(result).toEqual({ success: true });

      const logoutEntries = insertedAuditEntries.filter(
        (e) => e.action === "session_logout",
      );
      expect(logoutEntries).toHaveLength(1);
      const entry = logoutEntries[0]!;
      expect(entry.user_id).toBe("user-1");
      expect(entry.resource_type).toBe("session");
      expect(entry.resource_id).toBe("sess-to-logout");
      expect(entry.timestamp).toBeDefined();
    });

    it("does not write an audit entry when there is no sessionId", async () => {
      usersStore.push(makeUser("user-1"));

      const caller = authRouter.createCaller(makeCtx("user-1", null));
      await caller.logout();

      const logoutEntries = insertedAuditEntries.filter(
        (e) => e.action === "session_logout",
      );
      expect(logoutEntries).toHaveLength(0);
    });
  });

  describe("auth.refreshSession", () => {
    it("writes a session_refreshed audit entry when an old session is rotated", async () => {
      usersStore.push(makeUser("user-1"));
      sessionsStore.push({
        id: "old-sess",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
        refresh_token: "will-match",
      });

      // The refreshSession code hashes the token, then looks up the session
      // row. Our fake select ignores predicates and returns the whole table,
      // which is what we want for this unit test.
      const caller = authRouter.createCaller(makeCtx(null, null));
      const result = await caller.refreshSession({
        refresh_token: "any-raw-token",
      });

      expect(result.user.id).toBe("user-1");

      const refreshEntries = insertedAuditEntries.filter(
        (e) => e.action === "session_refreshed",
      );
      expect(refreshEntries).toHaveLength(1);
      const entry = refreshEntries[0]!;
      expect(entry.user_id).toBe("user-1");
      expect(entry.resource_type).toBe("session");
      expect(entry.resource_id).toBe("old-sess");
      const details = JSON.parse(entry.details as string);
      expect(details.old_session_id).toBe("old-sess");
      expect(details.new_session_id).toBeDefined();
    });
  });

  describe("enforceSessionLimit eviction", () => {
    it("writes session_evicted audit entries when oldest sessions are removed", async () => {
      // Seed 5 existing sessions (at the MAX_CONCURRENT_SESSIONS limit of 5).
      // Logging in a 6th time should evict the oldest one.
      const now = Date.now();
      usersStore.push({
        ...makeUser("user-1"),
        password_hash: "hashed:password123",
      });
      for (let i = 0; i < 5; i++) {
        sessionsStore.push({
          id: `sess-${i}`,
          user_id: "user-1",
          expires_at: new Date(now + 3_600_000).toISOString(),
          created_at: new Date(now - (5 - i) * 1000).toISOString(),
        });
      }

      const caller = authRouter.createCaller(makeCtx(null, null));
      await caller.login({
        email: "user-1@carebridge.dev",
        password: "password123",
      });

      const evictionEntries = insertedAuditEntries.filter(
        (e) => e.action === "session_evicted",
      );
      expect(evictionEntries.length).toBeGreaterThanOrEqual(1);
      const entry = evictionEntries[0]!;
      expect(entry.user_id).toBe("user-1");
      expect(entry.resource_type).toBe("session");
      const details = JSON.parse(entry.details as string);
      expect(details.reason).toContain("concurrent session limit");
    });
  });
});
