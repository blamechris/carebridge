import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

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
const deletedSessionIds: string[] = [];
let updatedPasswordHash: string | null = null;

function selectBuilder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  (chain as unknown as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve);
  return chain;
}

const mockDb = {
  select: vi.fn((_shape?: unknown) => {
    const holder: Record<string, unknown> = {};
    holder.from = vi.fn((table: unknown) => {
      const rows =
        table === "SESSIONS_TABLE"
          ? [...sessionsStore]
          : table === "USERS_TABLE"
            ? [...usersStore]
            : [];
      const nested: Record<string, unknown> = {};
      nested.where = vi.fn(() => nested);
      nested.orderBy = vi.fn(() => nested);
      nested.limit = vi.fn(() => Promise.resolve(rows));
      (nested as unknown as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve);
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
      return Promise.resolve();
    }),
  })),
  delete: vi.fn((_table: unknown) => ({
    where: vi.fn((_pred: unknown) => {
      // For changePassword, delete is called on sessions.
      // Track deletions but don't clear the store (tests check toDelete count via audit).
      const removed = sessionsStore.splice(0, sessionsStore.length);
      removed.forEach((r) => deletedSessionIds.push(r.id));
      const obj = {
        returning: vi.fn(() =>
          Promise.resolve(removed.map((r) => ({ id: r.id }))),
        ),
      };
      (obj as unknown as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
      ) => Promise.resolve().then(resolve);
      return obj;
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      if (values.password_hash) {
        updatedPasswordHash = values.password_hash as string;
      }
      return {
        where: vi.fn(() => Promise.resolve()),
      };
    }),
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
    async set() { return "OK"; }
    async get() { return null; }
    async del() { return 1; }
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
  deletedSessionIds.length = 0;
  updatedPasswordHash = null;
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

function makeCtx(userId: string, sessionId: string) {
  return {
    db: mockDb as unknown as ReturnType<typeof import("@carebridge/db-schema").getDb>,
    user: {
      id: userId,
      email: `${userId}@carebridge.dev`,
      name: `User ${userId}`,
      role: "physician" as const,
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    } as unknown as import("@carebridge/shared-types").User,
    sessionId,
    requestId: "req-1",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth.changePassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it("changes the password when the current password is correct", async () => {
    usersStore.push(makeUser("user-1"));
    sessionsStore.push({
      id: "current-session",
      user_id: "user-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
    });

    const caller = authRouter.createCaller(makeCtx("user-1", "current-session"));
    const result = await caller.changePassword({
      currentPassword: "password123",
      newPassword: "newSecurePass1",
    });

    expect(result).toEqual({ success: true });

    // Password should have been updated.
    expect(updatedPasswordHash).toBe("hashed:newSecurePass1");

    // Audit entry should be written.
    const auditEntries = insertedAuditEntries.filter(
      (e) => e.action === "password_changed",
    );
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]!.user_id).toBe("user-1");
    expect(auditEntries[0]!.resource_type).toBe("user");
  });

  it("rejects when the current password is wrong", async () => {
    usersStore.push(makeUser("user-1"));

    const caller = authRouter.createCaller(makeCtx("user-1", "current-session"));

    await expect(
      caller.changePassword({
        currentPassword: "wrongPassword",
        newPassword: "newSecurePass1",
      }),
    ).rejects.toThrow("Current password is incorrect");
  });

  it("rejects when new password matches current password", async () => {
    usersStore.push(makeUser("user-1"));

    const caller = authRouter.createCaller(makeCtx("user-1", "current-session"));

    await expect(
      caller.changePassword({
        currentPassword: "password123",
        newPassword: "password123",
      }),
    ).rejects.toThrow("New password must differ from the current password");
  });

  it("requires authentication", async () => {
    const caller = authRouter.createCaller({
      db: mockDb as unknown as ReturnType<typeof import("@carebridge/db-schema").getDb>,
      user: null,
      sessionId: null,
      requestId: "req-1",
    });

    await expect(
      caller.changePassword({
        currentPassword: "password123",
        newPassword: "newSecurePass1",
      }),
    ).rejects.toThrow("You must be logged in");
  });

  it("revokes other sessions on password change", async () => {
    usersStore.push(makeUser("user-1"));
    // Current session + two other sessions
    sessionsStore.push(
      {
        id: "current-session",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
      },
      {
        id: "other-session-1",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
      },
      {
        id: "other-session-2",
        user_id: "user-1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
      },
    );

    const caller = authRouter.createCaller(makeCtx("user-1", "current-session"));
    await caller.changePassword({
      currentPassword: "password123",
      newPassword: "newSecurePass1",
    });

    // The delete mock was called to revoke other sessions.
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
