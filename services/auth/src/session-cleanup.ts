import { getDb, sessions, auditLog } from "@carebridge/db-schema";
import { lt, or, and, isNotNull } from "drizzle-orm";
import crypto from "node:crypto";

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
 * Each deleted session generates a `session_idle_expired` audit log entry
 * (HIPAA § 164.312(b) — record of session lifecycle events).
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
    .returning({
      id: sessions.id,
      user_id: sessions.user_id,
      expires_at: sessions.expires_at,
      last_active_at: sessions.last_active_at,
      created_at: sessions.created_at,
    });

  const count = deleted.length;

  if (count > 0) {
    console.log(`[session-cleanup] Deleted ${count} expired/idle sessions`);

    // Write one audit entry per deleted session (HIPAA § 164.312(b)).
    const auditTimestamp = now.toISOString();
    for (const row of deleted) {
      let reason = "session_cleanup";
      if (row.expires_at && row.expires_at < expiredThreshold) {
        reason = "Absolute session expiry reached";
      } else if (row.created_at && row.created_at < hardCapThreshold) {
        reason = "Hard-cap session age exceeded (48h)";
      } else if (row.last_active_at && row.last_active_at < idleThreshold) {
        reason = "Idle timeout exceeded (15m)";
      }

      try {
        await db.insert(auditLog).values({
          id: crypto.randomUUID(),
          user_id: row.user_id,
          action: "session_idle_expired",
          resource_type: "session",
          resource_id: row.id,
          details: JSON.stringify({ reason }),
          timestamp: auditTimestamp,
        });
      } catch (err) {
        // Audit logging must never crash the cleanup job.
        console.error(
          `[session-cleanup] Failed to write audit entry for ${row.id}:`,
          err,
        );
      }
    }
  }

  return count;
}
