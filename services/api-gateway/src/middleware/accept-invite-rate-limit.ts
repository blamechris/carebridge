/**
 * Per-IP rate limit for the family-invite acceptance endpoint (issue #313).
 *
 * `familyAccess.acceptInvite` consumes an opaque bearer token — possession
 * of the token grants access to another patient's PHI. The 256-bit token
 * space makes brute-force computationally infeasible, but defense-in-depth
 * demands an explicit per-IP throttle to cap guess velocity and make abuse
 * visible in Redis and logs.
 *
 * Default cap: 10 attempts/hour/IP in production. Raised in dev to avoid
 * blocking manual testing.
 *
 * The counter uses Redis INCR with a sliding TTL set on the first
 * increment in a window, so each distinct IP gets its own fresh hour from
 * the moment it first touches the endpoint.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type Redis from "ioredis";

export const ACCEPT_INVITE_URL_PREFIX = "/trpc/familyAccess.acceptInvite";
export const ACCEPT_INVITE_WINDOW_SECONDS = 60 * 60;
export const ACCEPT_INVITE_KEY_PREFIX = "ratelimit:acceptInvite:";

export interface AcceptInviteRateLimitOptions {
  redis: Redis;
  max: number;
}

/**
 * Build a Fastify `onRequest` hook that enforces the acceptInvite rate
 * limit. Factored out of server bootstrap so it can be unit-tested in
 * isolation from the full server startup.
 */
export function makeAcceptInviteRateLimitHook(
  opts: AcceptInviteRateLimitOptions,
) {
  const { redis, max } = opts;

  return async function acceptInviteRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    if (!req.url?.startsWith(ACCEPT_INVITE_URL_PREFIX)) {
      return;
    }
    const key = `${ACCEPT_INVITE_KEY_PREFIX}${req.ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, ACCEPT_INVITE_WINDOW_SECONDS);
    }
    if (count > max) {
      const ttl = await redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : ACCEPT_INVITE_WINDOW_SECONDS;
      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `Too many invite attempts. Try again in ${retryAfter} seconds.`,
      });
    }
  };
}
