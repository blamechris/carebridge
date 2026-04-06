import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb, careTeamAssignments } from "@carebridge/db-schema";
import { eq, and, isNull } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/*  In-memory TTL cache for care-team lookups                         */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 60_000; // 60 seconds
const CACHE_MAX_ENTRIES = 10_000;

interface CacheEntry {
  value: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

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

  const hasAccess = rows.length > 0;
  setCache(cacheKey, hasAccess);
  return hasAccess;
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
    reply.code(403).send({ error: "Access denied: patients may only access their own records" });
    return false;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    reply.code(403).send({
      error: "Access denied: no active care-team assignment for this patient",
    });
    return false;
  }

  return true;
}
