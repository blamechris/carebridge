/**
 * Per-user rate limit for patient record read endpoints (issue #552).
 *
 * Prevents a logged-in user from enumerating patient data by calling
 * patients.getSummary or patients.getById in a tight loop.
 *
 * Each procedure has its own budget:
 *   - getSummary: 60 req/min/user (lower because it's a lightweight lookup)
 *   - getById:   120 req/min/user
 *
 * Uses Redis INCR with a sliding TTL per user+procedure pair. When a user
 * exceeds their budget, the hook returns 429 and emits an audit row so
 * security reviewers can spot enumeration attempts.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type Redis from "ioredis";
import type { User } from "@carebridge/shared-types";
import { getDb, auditLog } from "@carebridge/db-schema";
import crypto from "node:crypto";

export const PATIENT_READ_WINDOW_SECONDS = 60;
export const PATIENT_READ_KEY_PREFIX = "ratelimit:patientRead:";

export const PATIENT_READ_DEFAULTS = {
  getSummary: 60,
  getById: 120,
} as const;

/** URL prefixes for the two rate-limited procedures. */
const PROCEDURE_MATCHERS: Array<{
  prefix: string;
  procedure: keyof typeof PATIENT_READ_DEFAULTS;
}> = [
  { prefix: "/trpc/patients.getSummary", procedure: "getSummary" },
  { prefix: "/trpc/patients.getById", procedure: "getById" },
];

/** Audit event shape emitted when a rate limit is exceeded. */
export interface RateLimitAuditEvent {
  userId: string;
  procedureName: string;
  ip: string;
}

export interface PatientReadRateLimitOptions {
  redis: Redis;
  /** Per-procedure maximums. Falls back to PATIENT_READ_DEFAULTS. */
  maxGetSummary?: number;
  maxGetById?: number;
  /**
   * Optional audit emitter — called when a rate limit is exceeded.
   * Defaults to inserting a row into the audit_log table via Drizzle.
   */
  onExceedance?: (event: RateLimitAuditEvent) => Promise<void>;
}

/** Default audit emitter: writes a row to the audit_log table. */
async function defaultAuditEmitter(event: RateLimitAuditEvent): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: event.userId,
    action: "rate_limit_exceeded",
    resource_type: "patients",
    resource_id: "",
    procedure_name: event.procedureName,
    patient_id: null,
    ip_address: event.ip,
    http_status_code: 429,
    success: false,
    error_message: "Too Many Requests",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Build a Fastify `onRequest` hook that enforces per-user rate limits
 * on patients.getSummary and patients.getById.
 */
export function makePatientReadRateLimitHook(
  opts: PatientReadRateLimitOptions,
) {
  const { redis } = opts;
  const maxGetSummary = opts.maxGetSummary ?? PATIENT_READ_DEFAULTS.getSummary;
  const maxGetById = opts.maxGetById ?? PATIENT_READ_DEFAULTS.getById;
  const emitAudit = opts.onExceedance ?? defaultAuditEmitter;

  const limits: Record<string, number> = {
    getSummary: maxGetSummary,
    getById: maxGetById,
  };

  return async function patientReadRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    // Identify which procedure (if any) this request targets.
    let procedure: string | undefined;
    for (const m of PROCEDURE_MATCHERS) {
      if (req.url?.startsWith(m.prefix)) {
        procedure = m.procedure;
        break;
      }
    }
    if (!procedure) return;

    // Must have an authenticated user — unauthenticated requests are rejected
    // by the auth middleware before this hook fires, but guard defensively.
    const user = (req as unknown as Record<string, unknown>).user as
      | User
      | undefined;
    if (!user) return;

    const max = limits[procedure]!;
    const key = `${PATIENT_READ_KEY_PREFIX}${procedure}:${user.id}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, PATIENT_READ_WINDOW_SECONDS);
    }

    if (count > max) {
      const ttl = await redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : PATIENT_READ_WINDOW_SECONDS;

      // Emit an audit event for the exceedance so security can alert on it.
      try {
        await emitAudit({
          userId: user.id,
          procedureName: `patients.${procedure}`,
          ip: req.ip,
        });
      } catch {
        // Never let audit failure suppress the 429 response.
        req.log?.warn?.("Failed to write rate-limit audit event");
      }

      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded for patients.${procedure}. Try again in ${retryAfter} seconds.`,
      });
    }
  };
}
