import type { FastifyRequest, FastifyReply } from "fastify";
import { TRPCError } from "@trpc/server";
import type { User } from "@carebridge/shared-types";
import { hasPermission } from "@carebridge/shared-types";
import { getDb, careTeamAssignments, auditLog, emergencyAccess } from "@carebridge/db-schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import crypto from "node:crypto";

/**
 * tRPC-side RBAC enforcement: throws `FORBIDDEN` when the user's role
 * does not grant the requested permission per `ROLE_PERMISSIONS`.
 *
 * Prefer this over inline `user.role !== "admin"` checks so that all
 * permission logic flows through a single source of truth. Extending
 * a role's capabilities is then a one-line change in `ROLE_PERMISSIONS`
 * rather than a grep-and-edit across every router.
 */
export function assertPermission(
  user: User,
  permission: string,
  message = "Access denied",
): void {
  if (!hasPermission(user, permission)) {
    // Default message is intentionally generic — exposing the raw
    // permission key in the user-facing error leaks RBAC internals.
    // Callers can pass a domain-appropriate message (e.g. "Only admins
    // can revoke emergency access") to improve UX without revealing
    // the underlying permission identifier.
    // Per Copilot review on PR #381.
    throw new TRPCError({
      code: "FORBIDDEN",
      message,
    });
  }
}

/**
 * Log an RBAC access denial to the audit trail.
 *
 * Fires-and-forgets so it never blocks or crashes the request cycle.
 */
async function logAccessDenial(
  request: FastifyRequest,
  userId: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: userId,
      action: "access_denied",
      resource_type: "rbac",
      resource_id: "",
      details: JSON.stringify({ reason, ...details }),
      ip_address: request.ip,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    request.log.error({ err }, "Failed to write RBAC denial audit log");
  }
}

/* ------------------------------------------------------------------ */
/*  In-memory TTL cache for care-team lookups                         */
/* ------------------------------------------------------------------ */

// Hot path for HIPAA access checks: most requests hit it twice. Keep the
// local map for per-replica speed and layer Redis PUBSUB-backed invalidation
// on top so revocations propagate across replicas without waiting on TTL.
//
// TTL is kept as a defense-in-depth guard against dropped invalidation
// messages — 2 s bounds the worst-case staleness window if Redis PUBSUB
// misses a hop.
const CACHE_TTL_MS = 2_000;
const CACHE_MAX_ENTRIES = 10_000;

/** Redis PUBSUB channel carrying care-team cache invalidation messages. */
export const CARE_TEAM_INVALIDATE_CHANNEL = "rbac:care_team:invalidate";

interface CacheEntry {
  value: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, patientId: string): string {
  return `${userId}:${patientId}`;
}

function getCached(key: string): boolean | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: boolean): void {
  // Evict oldest entries when at capacity (simple FIFO via insertion order)
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Clear the entire care-team cache. Useful for testing and invalidation. */
export function clearCareTeamCache(): void {
  cache.clear();
}

/**
 * Invalidate a single care-team cache entry on this replica.
 *
 * Use {@link broadcastCareTeamInvalidation} to propagate invalidation across
 * all replicas via Redis PUBSUB.
 */
export function invalidateCareTeamCacheEntry(
  userId: string,
  patientId: string,
): void {
  cache.delete(cacheKey(userId, patientId));
}

/**
 * Invalidate every cache entry referring to the given patient on this
 * replica. Useful when the removal scope is the patient row rather than a
 * specific (user, patient) pair — e.g. bulk care-team rotations.
 */
export function invalidateCareTeamCacheForPatient(patientId: string): void {
  const suffix = `:${patientId}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/**
 * Apply an invalidation message received over Redis PUBSUB.
 *
 * Messages are of the form "userId:patientId" (from
 * {@link invalidateCareTeamCacheEntry}) or "*:patientId" to invalidate every
 * entry for that patient.
 *
 * Exported for unit testing the subscriber wiring.
 */
export function applyInvalidationMessage(message: string): void {
  if (!message) return;
  const [userIdRaw, patientIdRaw] = message.split(":", 2);
  if (!userIdRaw || !patientIdRaw) return;
  if (userIdRaw === "*") {
    invalidateCareTeamCacheForPatient(patientIdRaw);
    return;
  }
  invalidateCareTeamCacheEntry(userIdRaw, patientIdRaw);
}

/**
 * Publish an invalidation message to every replica listening on
 * {@link CARE_TEAM_INVALIDATE_CHANNEL}. Accepts a Redis-compatible
 * publisher (ioredis exposes `.publish(channel, message)`) so callers
 * inject their own connection — this module stays decoupled from any
 * specific Redis client.
 *
 * Fire-and-forget: a publish failure must never block the surrounding
 * mutation (e.g. marking a care-team assignment as removed), because
 * the source-of-truth change has already been written. Other replicas
 * will fall back to the 2 s TTL.
 */
export async function broadcastCareTeamInvalidation(
  publisher: { publish: (channel: string, message: string) => Promise<unknown> },
  userId: string | "*",
  patientId: string,
): Promise<void> {
  try {
    await publisher.publish(
      CARE_TEAM_INVALIDATE_CHANNEL,
      `${userId}:${patientId}`,
    );
  } catch {
    // Intentionally swallow — see jsdoc.
  }
  // Invalidate locally so the caller doesn't have to loop through its own
  // subscriber just to clear its own replica's cache.
  if (userId === "*") {
    invalidateCareTeamCacheForPatient(patientId);
  } else {
    invalidateCareTeamCacheEntry(userId, patientId);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Type-guard: returns `true` when `request.user` has been populated by
 * the auth middleware. Avoids an unsafe `as unknown as User` double-cast.
 */
function getUser(request: FastifyRequest): User | undefined {
  return (request as FastifyRequest & { user?: User }).user;
}

/**
 * Verify that the authenticated user has an active care-team assignment
 * for the given patient. Uses a short-lived in-memory cache (60 s TTL)
 * so repeated RBAC checks within the same request window avoid extra
 * round-trips to the database.
 */
export async function assertCareTeamAccess(
  userId: string,
  patientId: string,
): Promise<boolean> {
  const cacheKey = `${userId}:${patientId}`;

  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const db = getDb();
  const rows = await db
    .select({ id: careTeamAssignments.id })
    .from(careTeamAssignments)
    .where(
      and(
        eq(careTeamAssignments.user_id, userId),
        eq(careTeamAssignments.patient_id, patientId),
        isNull(careTeamAssignments.removed_at),
      ),
    )
    .limit(1);

  if (rows.length > 0) {
    setCache(cacheKey, true);
    return true;
  }

  // No care-team assignment — check for active emergency access grant.
  const now = new Date().toISOString();
  const emergencyRows = await db
    .select({ id: emergencyAccess.id })
    .from(emergencyAccess)
    .where(
      and(
        eq(emergencyAccess.user_id, userId),
        eq(emergencyAccess.patient_id, patientId),
        isNull(emergencyAccess.revoked_at),
        gt(emergencyAccess.expires_at, now),
      ),
    )
    .limit(1);

  if (emergencyRows.length > 0) {
    // Log emergency access usage distinctly in audit trail (fire-and-forget).
    db.insert(auditLog)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        action: "emergency_access_used",
        resource_type: "patient",
        resource_id: patientId,
        details: JSON.stringify({
          emergency_access_id: emergencyRows[0].id,
          type: "emergency_access",
        }),
        ip_address: "",
        timestamp: now,
      })
      .catch(() => {
        // Swallow — audit logging must never block access decisions.
      });

    setCache(cacheKey, true);
    return true;
  }

  setCache(cacheKey, false);
  return false;
}

/**
 * HIPAA minimum-necessary access check for patient data.
 *
 * - **patient**: may only access their own record (user.id === patientId)
 * - **admin**: unrestricted access
 * - **clinicians** (physician, specialist, nurse): must have an active
 *   care-team assignment linking them to the patient
 *
 * Sends a 403 response and returns `false` when access is denied so
 * callers can short-circuit:
 *
 * ```ts
 * if (!(await assertPatientAccess(request, reply, patientId))) return;
 * ```
 */
export async function assertPatientAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  patientId: string,
): Promise<boolean> {
  const user = getUser(request);

  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }

  // Admins have unrestricted access.
  if (user.role === "admin") {
    return true;
  }

  // Patients may only view their own records.
  if (user.role === "patient") {
    if (user.id === patientId) {
      return true;
    }
    await logAccessDenial(request, user.id, "patient_access_denied", {
      requested_patient_id: patientId,
      role: user.role,
    });
    reply.code(403).send({ error: "Access denied: patients may only access their own records" });
    return false;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    await logAccessDenial(request, user.id, "care_team_not_assigned", {
      requested_patient_id: patientId,
      role: user.role,
    });
    reply.code(403).send({
      error: "Access denied: no active care-team assignment for this patient",
    });
    return false;
  }

  return true;
}
