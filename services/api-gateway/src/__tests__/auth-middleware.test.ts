import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @carebridge/db-schema before importing the middleware
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockDelete = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

// Chainable query builder
function chainable(terminal: () => unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => terminal());
  return chain;
}

// We'll swap the terminal return per-call via mockLimit
let sessionRows: unknown[] = [];
let userRows: unknown[] = [];
let callIndex = 0;

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => {
    const idx = callIndex++;
    // First select() call is for sessions, second is for users
    return idx === 0 ? sessionRows : userRows;
  });
  return chain;
}

let latestSelectChain: ReturnType<typeof makeSelectChain>;

const deletedSessionIds: string[] = [];

const insertedAuditEntries: unknown[] = [];

const mockDb = {
  select: vi.fn(() => {
    latestSelectChain = makeSelectChain();
    return latestSelectChain;
  }),
  delete: vi.fn(() => ({
    where: vi.fn(() => {
      // Track that delete was called
      deletedSessionIds.push("deleted");
      return Promise.resolve();
    }),
  })),
  insert: vi.fn(() => ({
    values: vi.fn((entry: unknown) => {
      insertedAuditEntries.push(entry);
      return Promise.resolve();
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
  users: { id: "users.id" },
  sessions: { id: "sessions.id", user_id: "sessions.user_id" },
  auditLog: { id: "audit_log.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("@carebridge/auth", () => ({
  verifyJWT: async (token: string) => ({ sid: token }),
  JWTError: class JWTError extends Error {},
}));

import { authMiddleware } from "../middleware/auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    ...overrides,
  } as unknown as Parameters<typeof authMiddleware>[0];
}

function makeReply() {
  const reply: Record<string, unknown> = {};
  reply.code = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply as unknown as Parameters<typeof authMiddleware>[1];
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString(); // +1 hour
const PAST = new Date(Date.now() - 3_600_000).toISOString(); // -1 hour

const activeUser = {
  id: "user-1",
  email: "active@carebridge.dev",
  name: "Active User",
  role: "physician",
  specialty: "Internal Medicine",
  department: "General",
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const inactiveUser = {
  ...activeUser,
  id: "user-2",
  email: "inactive@carebridge.dev",
  name: "Inactive User",
  is_active: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callIndex = 0;
    sessionRows = [];
    userRows = [];
    deletedSessionIds.length = 0;
    insertedAuditEntries.length = 0;
  });

  it("allows an active user with a valid session", async () => {
    sessionRows = [{ id: "sess-1", user_id: "user-1", expires_at: FUTURE }];
    userRows = [activeUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-1" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    const user = request.user;
    expect(user).toBeDefined();
    expect(user?.id).toBe("user-1");
    expect(user?.is_active).toBe(true);
    expect((reply as unknown as Record<string, unknown>).code).not.toHaveBeenCalled();
  });

  it("returns 401 and deletes session for an inactive user", async () => {
    sessionRows = [{ id: "sess-2", user_id: "user-2", expires_at: FUTURE }];
    userRows = [inactiveUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-2" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // Should not attach user
    const user = request.user;
    expect(user).toBeUndefined();

    // Should respond 401
    expect((reply as unknown as Record<string, unknown>).code).toHaveBeenCalledWith(401);
    expect((reply as unknown as Record<string, unknown>).send).toHaveBeenCalledWith({
      error: "Session expired",
    });

    // Should have deleted the session
    expect(mockDb.delete).toHaveBeenCalled();
    expect(deletedSessionIds.length).toBe(1);
  });

  it("leaves user null for an expired session", async () => {
    sessionRows = [{ id: "sess-3", user_id: "user-1", expires_at: PAST }];
    userRows = [];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-3" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    const user = request.user;
    expect(user).toBeUndefined();
    // No 401 sent — the middleware just leaves user null for expired sessions
  });

  it("leaves user null when no session is found (idle/missing)", async () => {
    sessionRows = [];
    userRows = [];

    const request = makeRequest({
      headers: { authorization: "Bearer non-existent" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    const user = request.user;
    expect(user).toBeUndefined();
  });

  it("emits an audit log entry when rejecting a deactivated user session", async () => {
    sessionRows = [{ id: "sess-inactive", user_id: "user-2", expires_at: FUTURE }];
    userRows = [inactiveUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-inactive" },
      ip: "192.168.1.42",
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // Allow the non-blocking audit insert to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockDb.insert).toHaveBeenCalled();
    expect(insertedAuditEntries.length).toBe(1);

    const entry = insertedAuditEntries[0] as Record<string, unknown>;
    expect(entry.user_id).toBe("user-2");
    expect(entry.action).toBe("session_rejected_inactive");
    expect(entry.resource_type).toBe("session");
    expect(entry.resource_id).toBe("sess-inactive");
    expect(entry.ip_address).toBe("192.168.1.42");

    const details = JSON.parse(entry.details as string);
    expect(details.reason).toBe("User account is deactivated");
    expect(details.ip_address).toBe("192.168.1.42");
  });

  it("invalidates a session older than 12 hours (absolute expiry)", async () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    sessionRows = [{
      id: "sess-old",
      user_id: "user-1",
      expires_at: FUTURE,
      created_at: thirteenHoursAgo,
    }];
    userRows = [activeUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-old" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // User should not be attached — session exceeded absolute lifetime.
    const user = request.user;
    expect(user).toBeUndefined();

    // Session should have been deleted.
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("allows a session younger than 12 hours", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sessionRows = [{
      id: "sess-recent",
      user_id: "user-1",
      expires_at: FUTURE,
      created_at: twoHoursAgo,
    }];
    userRows = [activeUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-recent" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    const user = request.user;
    expect(user).toBeDefined();
    expect(user?.id).toBe("user-1");
  });
});
