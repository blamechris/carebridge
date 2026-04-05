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
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  users: { id: "users.id" },
  sessions: { id: "sessions.id", user_id: "sessions.user_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
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
  });

  it("allows an active user with a valid session", async () => {
    sessionRows = [{ id: "sess-1", user_id: "user-1", expires_at: FUTURE }];
    userRows = [activeUser];

    const request = makeRequest({
      headers: { authorization: "Bearer sess-1" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeDefined();
    expect((user as Record<string, unknown>).id).toBe("user-1");
    expect((user as Record<string, unknown>).is_active).toBe(true);
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
    const user = (request as unknown as Record<string, unknown>).user;
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

    const user = (request as unknown as Record<string, unknown>).user;
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

    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeUndefined();
  });
});
