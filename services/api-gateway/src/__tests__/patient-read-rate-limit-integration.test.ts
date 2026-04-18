/**
 * Integration test: rate-limit hook lifecycle ordering (issue #770).
 *
 * Boots a minimal Fastify server with auth + patient-read rate-limit hooks
 * to verify:
 *   1. The rate-limit preHandler fires after auth resolves the user
 *   2. A burst of authenticated requests triggers 429
 *   3. Audit event emitted with the correct user_id on exceedance
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { RateLimitAuditEvent } from "../middleware/patient-read-rate-limit.js";

// Mock db-schema before importing the middleware that uses it.
vi.mock("@carebridge/db-schema", () => ({
  getDb: vi.fn(),
  auditLog: {},
}));

const { makePatientReadRateLimitHook } = await import(
  "../middleware/patient-read-rate-limit.js"
);

/* ------------------------------------------------------------------ */
/*  In-memory Redis mock                                              */
/* ------------------------------------------------------------------ */

type MockRedis = {
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  ttl: ReturnType<typeof vi.fn>;
  _counts: Map<string, number>;
};

function createMockRedis(): MockRedis {
  const counts = new Map<string, number>();
  return {
    _counts: counts,
    incr: vi.fn(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 45),
  };
}

/* ------------------------------------------------------------------ */
/*  Test users                                                        */
/* ------------------------------------------------------------------ */

const TEST_USER = {
  id: "user-integration-1",
  email: "integration@test.dev",
  name: "Integration Tester",
  role: "physician" as const,
  is_active: true,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

/* ------------------------------------------------------------------ */
/*  Server builder                                                    */
/* ------------------------------------------------------------------ */

function buildServer(opts: {
  redis: MockRedis;
  maxGetSummary: number;
  onExceedance: (event: RateLimitAuditEvent) => Promise<void>;
}): FastifyInstance {
  const server = Fastify({ logger: false });

  // Simulated auth preHandler — populates req.user from x-test-user-id header.
  // This mirrors the real authMiddleware's effect without needing a database.
  server.addHook("preHandler", async (req) => {
    const userId = req.headers["x-test-user-id"] as string | undefined;
    if (userId) {
      (req as unknown as Record<string, unknown>).user = {
        ...TEST_USER,
        id: userId,
      };
    }
  });

  // Patient-read rate-limit hook — same registration order as server.ts.
  // Runs as preHandler AFTER the auth hook above, so req.user is populated.
  server.addHook(
    "preHandler",
    makePatientReadRateLimitHook({
      redis: opts.redis as never,
      maxGetSummary: opts.maxGetSummary,
      onExceedance: opts.onExceedance,
    }),
  );

  // Minimal route that simulates the tRPC patients.getSummary endpoint.
  server.get("/trpc/patients.getSummary", async (req) => {
    const user = (req as unknown as Record<string, unknown>).user as
      | typeof TEST_USER
      | undefined;
    return { ok: true, userId: user?.id ?? null };
  });

  return server;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("patient-read rate-limit integration (real Fastify server)", () => {
  let server: FastifyInstance;
  let redis: MockRedis;
  let auditEvents: RateLimitAuditEvent[];
  const MAX = 3;

  beforeAll(async () => {
    redis = createMockRedis();
    auditEvents = [];

    server = buildServer({
      redis,
      maxGetSummary: MAX,
      onExceedance: async (event) => {
        auditEvents.push(event);
      },
    });

    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    redis._counts.clear();
    auditEvents.length = 0;
  });

  it("rate-limit hook fires after auth resolves the user", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/trpc/patients.getSummary",
      headers: { "x-test-user-id": TEST_USER.id },
    });

    // Auth populated the user (200 means the route handler saw it).
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.userId).toBe(TEST_USER.id);

    // The rate-limit hook ran and incremented a per-user key (not per-IP),
    // proving it executed after auth resolved the user identity.
    const expectedKey = `ratelimit:patientRead:getSummary:${TEST_USER.id}`;
    expect(redis.incr).toHaveBeenCalledWith(expectedKey);
  });

  it("burst of authenticated requests triggers 429", async () => {
    const userId = "burst-user";

    // Send MAX allowed requests — all should succeed.
    for (let i = 0; i < MAX; i++) {
      const res = await server.inject({
        method: "GET",
        url: "/trpc/patients.getSummary",
        headers: { "x-test-user-id": userId },
      });
      expect(res.statusCode).toBe(200);
    }

    // The (MAX + 1)th request should be rejected with 429.
    const rejected = await server.inject({
      method: "GET",
      url: "/trpc/patients.getSummary",
      headers: { "x-test-user-id": userId },
    });

    expect(rejected.statusCode).toBe(429);
    const body = JSON.parse(rejected.body);
    expect(body.error).toBe("Too Many Requests");
    expect(rejected.headers["retry-after"]).toBeDefined();
  });

  it("audit event records the correct user_id on exceedance", async () => {
    const userId = "audit-check-user";

    // Exhaust the budget.
    for (let i = 0; i < MAX; i++) {
      await server.inject({
        method: "GET",
        url: "/trpc/patients.getSummary",
        headers: { "x-test-user-id": userId },
      });
    }

    // Trigger the rate-limit exceedance.
    await server.inject({
      method: "GET",
      url: "/trpc/patients.getSummary",
      headers: { "x-test-user-id": userId },
    });

    // Allow fire-and-forget audit promise to settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.userId).toBe(userId);
    expect(event.procedureName).toBe("patients.getSummary");
  });

  it("unauthenticated requests bypass the rate limiter entirely", async () => {
    // No x-test-user-id header → auth hook leaves req.user undefined.
    const response = await server.inject({
      method: "GET",
      url: "/trpc/patients.getSummary",
    });

    // Route still responds (no user gating on the test route).
    expect(response.statusCode).toBe(200);

    // Rate-limit hook should not have called Redis because there is no user.
    // (Previous tests may have called incr, so check the calls array for
    // any key that does NOT contain a user id — there should be none.)
    const unauthedCalls = redis.incr.mock.calls.filter(
      ([key]: [string]) => key.includes(":undefined") || key.endsWith(":"),
    );
    expect(unauthedCalls).toHaveLength(0);
  });
});
