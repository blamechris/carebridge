import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above the module-under-test import
// ---------------------------------------------------------------------------

// Track verifyJWT behavior per-test
const mockVerifyJWT = vi.fn();

vi.mock("@carebridge/auth", () => {
  class JWTError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "JWTError";
    }
  }
  return {
    verifyJWT: (...args: unknown[]) => mockVerifyJWT(...args),
    JWTError,
  };
});

// ---------------------------------------------------------------------------
// DB mock — mirrors the pattern from auth-middleware.test.ts
// ---------------------------------------------------------------------------

let sessionRows: unknown[] = [];
let userRows: unknown[] = [];
let callIndex = 0;

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => {
    const idx = callIndex++;
    return idx === 0 ? sessionRows : userRows;
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => makeSelectChain()),
  delete: vi.fn(() => ({
    where: vi.fn(() => Promise.resolve()),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => Promise.resolve()),
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

import { authMiddleware } from "../middleware/auth.js";
import { JWTError } from "@carebridge/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    ip: "127.0.0.1",
    ...overrides,
  } as unknown as Parameters<typeof authMiddleware>[0];
}

function makeReply() {
  const reply: Record<string, unknown> = {};
  reply.code = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply as unknown as Parameters<typeof authMiddleware>[1];
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authMiddleware — JWT verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callIndex = 0;
    sessionRows = [];
    userRows = [];
  });

  it("verifies JWT token before performing a DB lookup", async () => {
    mockVerifyJWT.mockResolvedValue({ sid: "sess-uuid-1" });
    sessionRows = [
      { id: "sess-uuid-1", user_id: "user-1", expires_at: FUTURE },
    ];
    userRows = [activeUser];

    const request = makeRequest({
      headers: { authorization: "Bearer some-jwt-token" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // verifyJWT was called with the raw token
    expect(mockVerifyJWT).toHaveBeenCalledWith("some-jwt-token");

    // DB was queried for the resolved session id, not the raw token
    expect(mockDb.select).toHaveBeenCalled();

    // User was resolved
    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeDefined();
    expect((user as Record<string, unknown>).id).toBe("user-1");
  });

  it("returns unauthenticated (no user) when JWT is invalid", async () => {
    mockVerifyJWT.mockRejectedValue(new JWTError("invalid signature"));

    const request = makeRequest({
      headers: { authorization: "Bearer bad-token" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // verifyJWT was called
    expect(mockVerifyJWT).toHaveBeenCalledWith("bad-token");

    // No DB lookup should happen
    expect(mockDb.select).not.toHaveBeenCalled();

    // User stays null — middleware does not send 401 for invalid JWT,
    // it just leaves the user unset for downstream handlers to decide.
    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeUndefined();
  });

  it("re-throws non-JWT errors from verifyJWT", async () => {
    const unexpectedError = new Error("crypto module crashed");
    mockVerifyJWT.mockRejectedValue(unexpectedError);

    const request = makeRequest({
      headers: { authorization: "Bearer some-token" },
    });
    const reply = makeReply();

    await expect(authMiddleware(request, reply)).rejects.toThrow(
      "crypto module crashed",
    );
  });

  it("leaves user null when no credentials are provided", async () => {
    const request = makeRequest({ headers: {} });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // Neither verifyJWT nor DB should be called
    expect(mockVerifyJWT).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();

    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeUndefined();
  });

  it("extracts session ID from cookie when no Authorization header", async () => {
    mockVerifyJWT.mockResolvedValue({ sid: "sess-from-cookie" });
    sessionRows = [
      { id: "sess-from-cookie", user_id: "user-1", expires_at: FUTURE },
    ];
    userRows = [activeUser];

    const request = makeRequest({
      headers: {},
      // @fastify/cookie populates request.cookies; the middleware reads it
      // from there now, not from the raw header.
      cookies: { session: "cookie-jwt-token", other: "value" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    expect(mockVerifyJWT).toHaveBeenCalledWith("cookie-jwt-token");

    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeDefined();
  });
});

describe("authMiddleware — dev bypass", () => {
  // The dev bypass is controlled by a module-level constant computed at import
  // time from process.env.CAREBRIDGE_DEV_AUTH. Since we can't re-import the
  // module per test, we test the *observable contract*: when the env var was
  // NOT set at import time (which is the case in this test file), the dev
  // bypass path is inactive, so x-dev-user-id headers are ignored.

  beforeEach(() => {
    vi.clearAllMocks();
    callIndex = 0;
    sessionRows = [];
    userRows = [];
  });

  it("ignores x-dev-user-id when CAREBRIDGE_DEV_AUTH is not enabled", async () => {
    // The module was imported without CAREBRIDGE_DEV_AUTH=true, so the
    // dev bypass should be inactive.
    const request = makeRequest({
      headers: { "x-dev-user-id": "dev-admin" },
    });
    const reply = makeReply();

    await authMiddleware(request, reply);

    // Without a Bearer token or cookie, the user stays null
    const user = (request as unknown as Record<string, unknown>).user;
    expect(user).toBeUndefined();

    // No JWT verification or DB lookup performed
    expect(mockVerifyJWT).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
