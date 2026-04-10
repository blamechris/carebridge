import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb, careTeamAssignments, auditLog } from "@carebridge/db-schema";
import { getFamilyRelationship } from "@carebridge/auth";
import { eq, and, isNull } from "drizzle-orm";
import crypto from "node:crypto";

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
/*  In-memory cache for care-team lookups                             */
/* ------------------------------------------------------------------ */

// Phase D P1 #7: care-team access is cached in-process to absorb bursty
// per-request RBAC checks, but cache staleness is bounded by two
// independent mechanisms:
//
//   1. Redis PUBSUB invalidation (primary) — callers that mutate the
//      care_team_assignments table publish an invalidation message on
//      the CARETEAM_INVALIDATE_CHANNEL with a selector (user_id, patient_id,
//      or both). Every api-gateway replica subscribed to that channel
//      drops matching cache entries immediately. This replaces the
//      previous 5-second polling TTL as the primary freshness mechanism
//      — revocations now propagate at Redis message latency instead of
//      up to 5 seconds.
//
//   2. Defense-in-depth TTL (fallback) — entries still expire after
//      60 seconds even without an invalidation message, so a dropped
//      subscriber connection or a missed publish cannot keep a stale
//      entry indefinitely. 60s is an intentional balance: long enough
//      to absorb bursts and reduce DB load, short enough that a Redis
//      outage can't persist a stale grant for more than a minute.
//
// The PUBSUB mechanism is opt-in per process: call
// `initCareTeamCacheInvalidation(pubClient, subClient)` once on boot.
// If init is skipped (tests, single-process dev environments), the
// module falls back silently to TTL-only behavior.
const CACHE_TTL_MS = 60_000; // 60 seconds — fallback only; PUBSUB is primary
const CACHE_MAX_ENTRIES = 10_000;

/** Redis channel used for cross-replica care-team cache invalidation. */
export const CARETEAM_INVALIDATE_CHANNEL = "carebridge:rbac:careteam-invalidate";

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
 * Invalidation selector shape carried over the Redis channel.
 *   - both user_id + patient_id  → evict exactly one cache entry
 *   - only user_id               → evict every entry for that user
 *                                  (revoking a clinician's access entirely)
 *   - only patient_id            → evict every entry for that patient
 *                                  (care team restructured)
 *   - neither                    → evict everything (full reset)
 */
export interface CareTeamInvalidateMessage {
  user_id?: string;
  patient_id?: string;
}

/**
 * Drop cache entries that match the selector. Exported so tests and the
 * PUBSUB listener can call it directly without round-tripping through Redis.
 */
export function invalidateCareTeamCache(
  selector: CareTeamInvalidateMessage,
): number {
  const { user_id, patient_id } = selector;
  if (!user_id && !patient_id) {
    const size = cache.size;
    cache.clear();
    return size;
  }
  if (user_id && patient_id) {
    return cache.delete(cacheKey(user_id, patient_id)) ? 1 : 0;
  }
  // Single-dimension eviction: walk the keys and match the prefix/suffix.
  let dropped = 0;
  for (const key of cache.keys()) {
    const [keyUser, keyPatient] = key.split(":", 2) as [string, string];
    if (user_id && keyUser === user_id) {
      cache.delete(key);
      dropped++;
      continue;
    }
    if (patient_id && keyPatient === patient_id) {
      cache.delete(key);
      dropped++;
    }
  }
  return dropped;
}

/**
 * Minimal publisher/subscriber surface the rbac module needs. Typed this
 * way instead of importing `ioredis` directly so tests can pass an
 * EventEmitter-like double without spinning up a real Redis connection.
 */
export interface RbacPubClient {
  publish(channel: string, message: string): Promise<number> | number;
}

export interface RbacSubClient {
  subscribe(channel: string): Promise<unknown> | unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

let pubClient: RbacPubClient | null = null;

/**
 * Attach the PUBSUB listener that drops cache entries in response to
 * invalidation messages. Safe to call more than once — additional calls
 * replace the previously stored publisher and attach an additional
 * listener to the subscriber (caller is responsible for using a fresh
 * subscriber if re-initializing, because ioredis cannot unsubscribe
 * cleanly mid-listener).
 *
 * If the module is never initialized, publish becomes a no-op and the
 * TTL fallback is the only freshness mechanism.
 */
export function initCareTeamCacheInvalidation(
  pub: RbacPubClient,
  sub: RbacSubClient,
): void {
  pubClient = pub;

  // Fire and forget — ioredis.subscribe returns a promise that resolves
  // with the subscription count; we don't need it and swallowing the
  // rejection here lets the gateway keep booting if Redis is transiently
  // down. The subscriber will retry in the background.
  const result = sub.subscribe(CARETEAM_INVALIDATE_CHANNEL);
  if (result && typeof (result as Promise<unknown>).then === "function") {
    (result as Promise<unknown>).catch((err: unknown) => {
      console.error(
        `[rbac] Failed to subscribe to ${CARETEAM_INVALIDATE_CHANNEL}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  sub.on("message", (channel: string, message: string) => {
    if (channel !== CARETEAM_INVALIDATE_CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as CareTeamInvalidateMessage;
      invalidateCareTeamCache(parsed);
    } catch (err) {
      console.error(
        "[rbac] Malformed care-team invalidation message:",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

/**
 * Publish an invalidation message to every api-gateway replica AND drop
 * the local cache entries immediately (so the publisher's own next
 * RBAC check sees the fresh state without waiting for the round-trip).
 *
 * Call this from every write path that mutates `care_team_assignments`.
 * A missed invalidation falls back to the TTL, so this is best-effort
 * from a correctness standpoint but must be called to meet the <1s
 * revocation propagation target.
 */
export async function publishCareTeamCacheInvalidation(
  selector: CareTeamInvalidateMessage,
): Promise<void> {
  // Always drop locally first — if publish fails we still want our own
  // replica to reflect the mutation the caller just performed.
  invalidateCareTeamCache(selector);

  if (!pubClient) return;
  try {
    await Promise.resolve(
      pubClient.publish(CARETEAM_INVALIDATE_CHANNEL, JSON.stringify(selector)),
    );
  } catch (err) {
    console.error(
      "[rbac] Failed to publish care-team invalidation:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Test helper: reset the module state between specs. */
export function __resetRbacModuleForTests(): void {
  pubClient = null;
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
  const key = cacheKey(userId, patientId);

  const cached = getCached(key);
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
  setCache(key, hasAccess);
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
    await logAccessDenial(request, user.id, "patient_access_denied", {
      requested_patient_id: patientId,
      role: user.role,
    });
    reply.code(403).send({ error: "Access denied: patients may only access their own records" });
    return false;
  }

  // Family caregivers must have an active relationship with the patient.
  if (user.role === "family_caregiver") {
    const rel = await getFamilyRelationship(user.id, patientId);
    if (!rel) {
      await logAccessDenial(request, user.id, "family_relationship_not_found", {
        requested_patient_id: patientId,
        role: user.role,
      });
      reply.code(403).send({
        error: "Access denied: no active family relationship for this patient",
      });
      return false;
    }
    return true;
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
