import { getDb, sessions } from "@carebridge/db-schema";
import { lt, or, and, isNotNull } from "drizzle-orm";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HARD_CAP_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Delete sessions that are expired, idle, or exceed the hard cap.
 *
 * Criteria (any match triggers deletion):
 *  1. `expires_at` is in the past (absolute expiry)
 *  2. `last_active_at` is non-null AND older than 15 minutes (idle timeout)
 *  3. `created_at` is older than 48 hours (hard cap)
 *
 * Returns the number of deleted sessions.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = getDb();
  const now = new Date();

  const expiredThreshold = now.toISOString();
  const idleThreshold = new Date(now.getTime() - IDLE_TIMEOUT_MS).toISOString();
  const hardCapThreshold = new Date(now.getTime() - HARD_CAP_MS).toISOString();

  const deleted = await db
    .delete(sessions)
    .where(
      or(
        // 1. Absolute expiry
        lt(sessions.expires_at, expiredThreshold),
        // 2. Idle timeout (only when last_active_at is set)
        and(
          isNotNull(sessions.last_active_at),
          lt(sessions.last_active_at, idleThreshold),
        ),
        // 3. Hard cap on session age
        lt(sessions.created_at, hardCapThreshold),
      ),
    )
    .returning({ id: sessions.id });

  const count = deleted.length;

  if (count > 0) {
    console.log(`[session-cleanup] Deleted ${count} expired/idle sessions`);
  }

  return count;
}
