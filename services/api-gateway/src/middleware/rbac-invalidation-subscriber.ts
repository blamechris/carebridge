/**
 * Redis PUBSUB subscriber that applies care-team cache invalidations
 * published from any replica.
 *
 * The subscriber is a thin wrapper: we lazily import ioredis so the RBAC
 * module itself stays transport-agnostic and unit tests can substitute an
 * in-memory publisher/subscriber pair (see rbac.test.ts).
 *
 * Usage (from the server bootstrap):
 *
 *   const subscriber = await startCareTeamInvalidationSubscriber();
 *   // ... graceful shutdown: await subscriber.quit();
 */

import { getRedisConnection } from "@carebridge/redis-config";
import {
  CARE_TEAM_INVALIDATE_CHANNEL,
  applyInvalidationMessage,
} from "./rbac.js";

export interface InvalidationSubscriber {
  quit(): Promise<void>;
}

/**
 * Subscribe to the care-team invalidation channel and wire incoming
 * messages into the local cache. Returns a handle whose `quit()` should be
 * called during graceful shutdown.
 *
 * Connection/parsing errors are logged via the provided logger but never
 * thrown — a broken subscriber degrades to TTL-based invalidation rather
 * than blocking the request path.
 */
/** Minimal interface the subscriber uses — keeps us from pulling in ioredis types at the top. */
interface RedisLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** Handle returned when startup failed; .quit() is a no-op so callers don't branch. */
const NOOP_SUBSCRIBER: InvalidationSubscriber = {
  async quit() {
    // Startup failed; nothing to close.
  },
};

export async function startCareTeamInvalidationSubscriber(
  logger: { warn: (obj: unknown, msg: string) => void } = {
    warn: () => undefined,
  },
): Promise<InvalidationSubscriber> {
  let sub: RedisLike | undefined;
  try {
    const { default: Redis } = await import("ioredis");
    const connection = getRedisConnection();
    sub = new Redis(connection) as unknown as RedisLike;

    sub.on("error", (err: unknown) => {
      logger.warn({ err }, "care-team invalidation subscriber error");
    });

    await sub.subscribe(CARE_TEAM_INVALIDATE_CHANNEL);

    sub.on("message", (...args: unknown[]) => {
      const [channel, message] = args as [string, string];
      if (channel !== CARE_TEAM_INVALIDATE_CHANNEL) return;
      try {
        applyInvalidationMessage(message);
      } catch (err) {
        logger.warn({ err, message }, "failed to apply invalidation message");
      }
    });

    const liveSub = sub;
    return {
      async quit() {
        try {
          await liveSub.quit();
        } catch {
          // Already closed — ignore.
        }
      },
    };
  } catch (err) {
    // Startup failed (ACL, auth mismatch, DNS, transient network, etc.).
    // Degrade to TTL-only invalidation rather than blocking gateway boot.
    logger.warn(
      { err },
      "care-team invalidation subscriber unavailable; falling back to TTL-only invalidation",
    );

    if (sub) {
      try {
        await sub.quit();
      } catch {
        // Best-effort cleanup after partial initialization failure.
      }
    }

    return NOOP_SUBSCRIBER;
  }
}
