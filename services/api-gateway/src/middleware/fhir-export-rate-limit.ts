/**
 * Per-user rate limit for FHIR exportPatient endpoint (issue #234).
 *
 * Prevents bulk patient data exfiltration by limiting each user to
 * 5 export requests per hour. When a user exceeds their budget, the
 * hook returns 429 and emits an audit row flagging a suspicious bulk
 * export pattern.
 *
 * Uses Redis INCR with a sliding TTL per user key. Runs as a
 * preHandler hook so that authMiddleware has already populated
 * `req.user` before the rate-limit check executes.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type Redis from "ioredis";
import { getDb, auditLog } from "@carebridge/db-schema";
import crypto from "node:crypto";

export const FHIR_EXPORT_WINDOW_SECONDS = 3600;
export const FHIR_EXPORT_MAX_DEFAULT = 5;
export const FHIR_EXPORT_KEY_PREFIX = "ratelimit:fhirExport:";

/** URL prefix for the exportPatient tRPC procedure. */
const EXPORT_URL_PREFIX = "/trpc/fhir.exportPatient";

/** Audit event shape emitted when a rate limit is exceeded. */
export interface FhirExportAuditEvent {
  userId: string;
  procedureName: string;
  ip: string;
  /**
   * Current request count for this user in the active window. Included so
   * downstream trend analysis can distinguish borderline exceedances
   * (e.g. 6/5) from aggressive scraping patterns (e.g. 50/5).
   */
  count: number;
}

export interface FhirExportRateLimitOptions {
  redis: Redis;
  /** Maximum exports per user per hour. Defaults to 5. */
  max?: number;
  /**
   * Optional audit emitter — called when a rate limit is exceeded.
   * Defaults to inserting a row into the audit_log table via Drizzle.
   */
  onExceedance?: (event: FhirExportAuditEvent) => Promise<void>;
}

/** Default audit emitter: writes a row to the audit_log table. */
async function defaultAuditEmitter(event: FhirExportAuditEvent): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: event.userId,
    action: "rate_limit_exceeded",
    resource_type: "fhir_export",
    resource_id: "",
    procedure_name: event.procedureName,
    patient_id: null,
    // Persist the current request count so trend analysis can distinguish
    // borderline exceedances (e.g. 6/5) from scraping patterns (e.g. 50/5).
    details: JSON.stringify({ count: event.count }),
    ip_address: event.ip,
    http_status_code: 429,
    success: false,
    error_message: "Suspicious bulk export pattern — rate limit exceeded",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Build a Fastify `preHandler` hook that enforces per-user rate limits
 * on fhir.exportPatient.
 *
 * Runs in the preHandler phase so that authMiddleware has already
 * populated `req.user` before the rate-limit check executes.
 */
export function makeFhirExportRateLimitHook(
  opts: FhirExportRateLimitOptions,
) {
  const { redis } = opts;
  const max = opts.max ?? FHIR_EXPORT_MAX_DEFAULT;
  const emitAudit = opts.onExceedance ?? defaultAuditEmitter;

  return async function fhirExportRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    // Only apply to the exportPatient procedure.
    if (!req.url?.startsWith(EXPORT_URL_PREFIX)) return;

    // Must have an authenticated user — this hook runs as preHandler after
    // authMiddleware, so req.user should be populated. Guard defensively.
    const user = req.user;
    if (!user) return;

    const key = `${FHIR_EXPORT_KEY_PREFIX}${user.id}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, FHIR_EXPORT_WINDOW_SECONDS);
    }

    if (count > max) {
      const ttl = await redis.ttl(key);
      const retryAfter = ttl > 0 ? ttl : FHIR_EXPORT_WINDOW_SECONDS;

      // Emit an audit event flagging suspicious bulk export pattern.
      // Fire-and-forget: don't block the 429 response on audit I/O.
      void emitAudit({
        userId: user.id,
        procedureName: "fhir.exportPatient",
        ip: req.ip,
        count,
      }).catch((err: unknown) => {
        req.log?.warn?.({ err }, "Failed to write FHIR export rate-limit audit event");
      });

      reply.header("retry-after", String(retryAfter));
      return reply.code(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded for fhir.exportPatient. Try again in ${retryAfter} seconds.`,
      });
    }
  };
}
