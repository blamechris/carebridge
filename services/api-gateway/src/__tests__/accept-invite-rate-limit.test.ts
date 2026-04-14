/**
 * Tests for the acceptInvite per-endpoint rate-limit hook (issue #313).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeAcceptInviteRateLimitHook,
  ACCEPT_INVITE_WINDOW_SECONDS,
  ACCEPT_INVITE_KEY_PREFIX,
} from "../middleware/accept-invite-rate-limit.js";

type MockRedis = {
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  ttl: ReturnType<typeof vi.fn>;
  _counts: Map<string, number>;
};

function createMockRedis(): MockRedis {
  const counts = new Map<string, number>();
  const redis: MockRedis = {
    _counts: counts,
    incr: vi.fn(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 3600),
  };
  return redis;
}

function makeReq(url: string, ip = "1.2.3.4") {
  return { url, ip } as unknown as Parameters<
    ReturnType<typeof makeAcceptInviteRateLimitHook>
  >[0];
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
    ReturnType<typeof makeAcceptInviteRateLimitHook>
  >[1] & typeof reply;
}

describe("acceptInvite rate limit hook", () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it("is a no-op for URLs outside the acceptInvite route", async () => {
    const hook = makeAcceptInviteRateLimitHook({ redis: redis as never, max: 10 });
    const reply = makeReply();

    await hook(makeReq("/trpc/auth.login"), reply);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("allows the first request through and sets the window TTL", async () => {
    const hook = makeAcceptInviteRateLimitHook({ redis: redis as never, max: 10 });
    const reply = makeReply();

    await hook(makeReq("/trpc/familyAccess.acceptInvite"), reply);
    expect(redis.incr).toHaveBeenCalledWith(
      `${ACCEPT_INVITE_KEY_PREFIX}1.2.3.4`,
    );
    expect(redis.expire).toHaveBeenCalledWith(
      `${ACCEPT_INVITE_KEY_PREFIX}1.2.3.4`,
      ACCEPT_INVITE_WINDOW_SECONDS,
    );
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("allows up to `max` requests and rejects the (max+1)th", async () => {
    const MAX = 3;
    const hook = makeAcceptInviteRateLimitHook({ redis: redis as never, max: MAX });

    for (let i = 0; i < MAX; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/familyAccess.acceptInvite"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }

    const reply = makeReply();
    await hook(makeReq("/trpc/familyAccess.acceptInvite"), reply);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect((reply as unknown as { _body: { error: string } })._body.error).toBe(
      "Too Many Requests",
    );
    expect(reply.header).toHaveBeenCalledWith("retry-after", expect.any(String));
    // expire should only be set on the first request of a window
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("rate-limits per IP independently", async () => {
    const hook = makeAcceptInviteRateLimitHook({ redis: redis as never, max: 2 });

    // IP A exhausts its budget
    for (let i = 0; i < 2; i++) {
      const reply = makeReply();
      await hook(makeReq("/trpc/familyAccess.acceptInvite", "1.1.1.1"), reply);
      expect(reply.code).not.toHaveBeenCalled();
    }
    const replyBlockedA = makeReply();
    await hook(makeReq("/trpc/familyAccess.acceptInvite", "1.1.1.1"), replyBlockedA);
    expect(replyBlockedA.code).toHaveBeenCalledWith(429);

    // IP B still has its full budget
    const replyB = makeReply();
    await hook(makeReq("/trpc/familyAccess.acceptInvite", "2.2.2.2"), replyB);
    expect(replyB.code).not.toHaveBeenCalled();
  });

  it("matches sub-paths under the acceptInvite prefix (e.g. query strings)", async () => {
    const hook = makeAcceptInviteRateLimitHook({ redis: redis as never, max: 10 });
    const reply = makeReply();

    await hook(
      makeReq("/trpc/familyAccess.acceptInvite?batch=1"),
      reply,
    );
    expect(redis.incr).toHaveBeenCalled();
  });
});
