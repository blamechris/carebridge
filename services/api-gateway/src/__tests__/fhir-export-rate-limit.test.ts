/**
 * Tests for per-user rate limit on fhir.exportPatient (issue #234).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FhirExportAuditEvent } from "../middleware/fhir-export-rate-limit.js";

vi.mock("@carebridge/db-schema", () => ({
  getDb: vi.fn(),
  auditLog: {},
}));

const {
  makeFhirExportRateLimitHook,
  FHIR_EXPORT_WINDOW_SECONDS,
  FHIR_EXPORT_KEY_PREFIX,
  FHIR_EXPORT_MAX_DEFAULT,
} = await import("../middleware/fhir-export-rate-limit.js");

/** Flush pending microtasks so fire-and-forget audit promises settle. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

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
    ttl: vi.fn(async () => 1800),
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
  } as unknown as Parameters<ReturnType<typeof makeFhirExportRateLimitHook>>[0];
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
    ReturnType<typeof makeFhirExportRateLimitHook>
  >[1] & typeof reply;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("FHIR export per-user rate limit", () => {
  let redis: MockRedis;
  let auditEvents: FhirExportAuditEvent[];

  beforeEach(() => {
    redis = createMockRedis();
    auditEvents = [];
  });

  function makeHook(overrides?: { max?: number }) {
    return makeFhirExportRateLimitHook({
      redis: redis as never,
      ...overrides,
      onExceedance: async (event) => {
        auditEvents.push(event);
      },
    });
  }

  it("exports correct defaults", () => {
    expect(FHIR_EXPORT_MAX_DEFAULT).toBe(5);
    expect(FHIR_EXPORT_WINDOW_SECONDS).toBe(3600);
  });

  it("is a no-op for URLs outside fhir.exportPatient", async () => {
    const hook = makeHook();
    const reply = makeReply();

    await hook(makeReq("/trpc/fhir.getByPatient"), reply);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("is a no-op for unauthenticated requests", async () => {
    const hook = makeHook();
    const reply = makeReply();
    const req = makeReq("/trpc/fhir.exportPatient");
    req.user = undefined;

    await hook(req, reply);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("allows requests within the limit", async () => {
    const hook = makeHook({ max: 5 });

    for (let i = 0; i < 5; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/fhir.exportPatient"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
  });

  it("rejects request after limit exceeded with 429", async () => {
    const MAX = 5;
    const hook = makeHook({ max: MAX });

    for (let i = 0; i < MAX; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/fhir.exportPatient"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }

    const reply = makeReply();
    await hook(makeReq("/trpc/fhir.exportPatient"), reply);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(
      (reply as unknown as { _body: { error: string } })._body.error,
    ).toBe("Too Many Requests");
    expect(reply.header).toHaveBeenCalledWith("retry-after", expect.any(String));
  });

  it("emits audit event on exceedance with suspicious bulk export message", async () => {
    const hook = makeHook({ max: 1 });

    // First request: allowed
    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());
    expect(auditEvents).toHaveLength(0);

    // Second request: exceeds
    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());
    await flushMicrotasks();
    expect(auditEvents).toHaveLength(1);

    const event = auditEvents[0]!;
    expect(event.userId).toBe("user-1");
    expect(event.procedureName).toBe("fhir.exportPatient");
    expect(event.ip).toBe("1.2.3.4");
  });

  it("rate-limits per user independently", async () => {
    const hook = makeHook({ max: 2 });

    // User A exhausts budget
    for (let i = 0; i < 2; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/fhir.exportPatient", "user-a"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
    const blockedA = makeReply();
    await hook(makeReq("/trpc/fhir.exportPatient", "user-a"), blockedA);
    expect(blockedA.code).toHaveBeenCalledWith(429);

    // User B still has full budget
    const replyB = makeReply();
    await hook(makeReq("/trpc/fhir.exportPatient", "user-b"), replyB);
    expect(replyB.code).not.toHaveBeenCalled();
  });

  it("matches URLs with query strings", async () => {
    const hook = makeHook({ max: 10 });
    const reply = makeReply();

    await hook(makeReq("/trpc/fhir.exportPatient?batch=1&input={}"), reply);
    expect(redis.incr).toHaveBeenCalled();
  });

  it("sets TTL only on the first request of a window", async () => {
    const hook = makeHook({ max: 10 });

    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());
    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());
    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());

    // expire called once (count === 1 on first request only)
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith(
      `${FHIR_EXPORT_KEY_PREFIX}user-1`,
      FHIR_EXPORT_WINDOW_SECONDS,
    );
  });

  it("uses 1-hour window for TTL", async () => {
    const hook = makeHook({ max: 10 });

    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());

    expect(redis.expire).toHaveBeenCalledWith(
      expect.any(String),
      3600,
    );
  });

  it("does not interfere with other fhir routes", async () => {
    const hook = makeHook({ max: 1 });

    // Exhaust export budget
    await hook(makeReq("/trpc/fhir.exportPatient"), makeReply());
    const blocked = makeReply();
    await hook(makeReq("/trpc/fhir.exportPatient"), blocked);
    expect(blocked.code).toHaveBeenCalledWith(429);

    // Other FHIR routes unaffected
    const importReply = makeReply();
    await hook(makeReq("/trpc/fhir.importBundle"), importReply);
    expect(importReply.code).not.toHaveBeenCalled();

    const getReply = makeReply();
    await hook(makeReq("/trpc/fhir.getByPatient"), getReply);
    expect(getReply.code).not.toHaveBeenCalled();
  });
});
