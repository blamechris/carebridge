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
export async function startCareTeamInvalidationSubscriber(
  logger: { warn: (obj: unknown, msg: string) => void } = {
    warn: () => undefined,
  },
): Promise<InvalidationSubscriber> {
  const { default: Redis } = await import("ioredis");
  const connection = getRedisConnection();
  const sub = new Redis(connection);

  sub.on("error", (err: Error) => {
    logger.warn({ err }, "care-team invalidation subscriber error");
  });

  await sub.subscribe(CARE_TEAM_INVALIDATE_CHANNEL);
  sub.on("message", (channel: string, message: string) => {
    if (channel !== CARE_TEAM_INVALIDATE_CHANNEL) return;
    try {
      applyInvalidationMessage(message);
    } catch (err) {
      logger.warn({ err, message }, "failed to apply invalidation message");
    }
  });

  return {
    async quit() {
      try {
        await sub.quit();
      } catch {
        // Already closed — ignore.
      }
    },
  };
}
