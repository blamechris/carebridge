/**
 * Tests for per-user rate limit on patients.getSummary and patients.getById (issue #552).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RateLimitAuditEvent } from "../middleware/patient-read-rate-limit.js";

// Dynamic import so the module-level db-schema import in the middleware
// is intercepted by vi.mock before resolution.
vi.mock("@carebridge/db-schema", () => ({
  getDb: vi.fn(),
  auditLog: {},
}));

const {
  makePatientReadRateLimitHook,
  PATIENT_READ_WINDOW_SECONDS,
  PATIENT_READ_KEY_PREFIX,
  PATIENT_READ_DEFAULTS,
} = await import("../middleware/patient-read-rate-limit.js");

/* ------------------------------------------------------------------ */
/*  Mock Redis                                                        */
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
/*  Request / Reply factories                                         */
/* ------------------------------------------------------------------ */

function makeReq(
  url: string,
  userId: string = "user-1",
  ip: string = "1.2.3.4",
) {
  return {
    url,
    ip,
    user: {
      id: userId,
      email: `${userId}@test.dev`,
      name: "Test User",
      role: "physician",
      is_active: true,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    },
    log: { warn: vi.fn() },
  } as unknown as Parameters<ReturnType<typeof makePatientReadRateLimitHook>>[0];
}

function makeReply() {
  const reply = {
    _status: 0,
    _body: undefined as unknown,
    _headers: {} as Record<string, string>,
    code: vi.fn(function (this: typeof reply, n: number) {
      this._status = n;
      return this;
    }),
    send: vi.fn(function (this: typeof reply, body: unknown) {
      this._body = body;
      return this;
    }),
    header: vi.fn(function (this: typeof reply, k: string, v: string) {
      this._headers[k] = v;
      return this;
    }),
  };
  return reply as unknown as Parameters<
    ReturnType<typeof makePatientReadRateLimitHook>
  >[1] & typeof reply;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("patient read per-user rate limit", () => {
  let redis: MockRedis;
  let auditEvents: RateLimitAuditEvent[];

  beforeEach(() => {
    redis = createMockRedis();
    auditEvents = [];
  });

  function makeHook(overrides?: { maxGetSummary?: number; maxGetById?: number }) {
    return makePatientReadRateLimitHook({
      redis: redis as never,
      ...overrides,
      onExceedance: async (event) => {
        auditEvents.push(event);
      },
    });
  }

  it("is a no-op for URLs outside getSummary/getById", async () => {
    const hook = makeHook();
    const reply = makeReply();

    await hook(makeReq("/trpc/patients.list"), reply);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("is a no-op for unauthenticated requests", async () => {
    const hook = makeHook();
    const reply = makeReply();
    const req = makeReq("/trpc/patients.getSummary");
    // Remove user
    (req as unknown as Record<string, unknown>).user = undefined;

    await hook(req, reply);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("allows normal caller through for getSummary", async () => {
    const hook = makeHook({ maxGetSummary: 5 });

    for (let i = 0; i < 5; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/patients.getSummary"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
  });

  it("allows normal caller through for getById", async () => {
    const hook = makeHook({ maxGetById: 5 });

    for (let i = 0; i < 5; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/patients.getById"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
  });

  it("rejects getSummary after burst exceeds limit with 429", async () => {
    const MAX = 3;
    const hook = makeHook({ maxGetSummary: MAX });

    for (let i = 0; i < MAX; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/patients.getSummary"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }

    const reply = makeReply();
    await hook(makeReq("/trpc/patients.getSummary"), reply);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(
      (reply as unknown as { _body: { error: string } })._body.error,
    ).toBe("Too Many Requests");
    expect(reply.header).toHaveBeenCalledWith("retry-after", expect.any(String));
  });

  it("rejects getById after burst exceeds limit with 429", async () => {
    const MAX = 3;
    const hook = makeHook({ maxGetById: MAX });

    for (let i = 0; i < MAX; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/patients.getById"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }

    const reply = makeReply();
    await hook(makeReq("/trpc/patients.getById"), reply);
    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it("records an audit event on exceedance", async () => {
    const hook = makeHook({ maxGetSummary: 1 });

    // First request: allowed
    await hook(makeReq("/trpc/patients.getSummary"), makeReply());
    expect(auditEvents).toHaveLength(0);

    // Second request: exceeds
    await hook(makeReq("/trpc/patients.getSummary"), makeReply());
    expect(auditEvents).toHaveLength(1);

    const event = auditEvents[0]!;
    expect(event.userId).toBe("user-1");
    expect(event.procedureName).toBe("patients.getSummary");
    expect(event.ip).toBe("1.2.3.4");
  });

  it("rate-limits per user independently", async () => {
    const hook = makeHook({ maxGetSummary: 2 });

    // User A exhausts budget
    for (let i = 0; i < 2; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/patients.getSummary", "user-a"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
    const blockedA = makeReply();
    await hook(makeReq("/trpc/patients.getSummary", "user-a"), blockedA);
    expect(blockedA.code).toHaveBeenCalledWith(429);

    // User B still has full budget
    const replyB = makeReply();
    await hook(makeReq("/trpc/patients.getSummary", "user-b"), replyB);
    expect(replyB.code).not.toHaveBeenCalled();
  });

  it("uses separate counters for getSummary and getById", async () => {
    const hook = makeHook({ maxGetSummary: 2, maxGetById: 2 });

    // Exhaust getSummary
    for (let i = 0; i < 2; i++) {
      await hook(makeReq("/trpc/patients.getSummary"), makeReply());
    }
    const blockedSummary = makeReply();
    await hook(makeReq("/trpc/patients.getSummary"), blockedSummary);
    expect(blockedSummary.code).toHaveBeenCalledWith(429);

    // getById is still available
    const replyById = makeReply();
    await hook(makeReq("/trpc/patients.getById"), replyById);
    expect(replyById.code).not.toHaveBeenCalled();
  });

  it("matches URLs with query strings", async () => {
    const hook = makeHook({ maxGetSummary: 10 });
    const reply = makeReply();

    await hook(makeReq("/trpc/patients.getSummary?batch=1"), reply);
    expect(redis.incr).toHaveBeenCalled();
  });

  it("sets TTL only on the first request of a window", async () => {
    const hook = makeHook({ maxGetSummary: 10 });

    await hook(makeReq("/trpc/patients.getSummary"), makeReply());
    await hook(makeReq("/trpc/patients.getSummary"), makeReply());
    await hook(makeReq("/trpc/patients.getSummary"), makeReply());

    // expire called once (count === 1 on first request only)
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith(
      `${PATIENT_READ_KEY_PREFIX}getSummary:user-1`,
      PATIENT_READ_WINDOW_SECONDS,
    );
  });

  it("exports correct default limits", () => {
    expect(PATIENT_READ_DEFAULTS.getSummary).toBe(60);
    expect(PATIENT_READ_DEFAULTS.getById).toBe(120);
  });
});
