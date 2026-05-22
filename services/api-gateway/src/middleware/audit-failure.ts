/**
 * Audit-write failure visibility (#996).
 *
 * The audit-after-PHI-mutation pattern wraps the audit insert in a try/catch
 * or `.catch(() => {})` so an audit failure does not crash the request
 * cycle. That intent is correct — what was missing was visibility into
 * the failures. With this helper, an audit insert that fails still does
 * not crash the request, but it DOES land in the structured-log stream
 * with a stable `msg` so log aggregators / alerting can detect ongoing
 * audit-write degradation.
 *
 * HIPAA §164.312(b) requires audit trail integrity. Silent failures
 * undermine that requirement; visible failures preserve the
 * "never block the request path" property while making the gap
 * observable for the on-call.
 */

import { createLogger } from "@carebridge/logger";

const log = createLogger("audit");

/**
 * Stable log msg searched on by alerts and dashboards. Do not change
 * without coordinating with whatever consumes the structured log stream.
 */
export const AUDIT_WRITE_FAILED_MSG = "audit_write_failed";

export interface AuditWriteFailureContext {
  /**
   * Short identifier for the call site (e.g. "rbac.emergency_access_used"
   * or "auth.session_rejected_inactive"). Lets a single alert split by
   * source so partial outages are diagnosable.
   */
  site: string;
  userId?: string | null;
  patientId?: string | null;
  action?: string | null;
  /** Free-form additional context the caller wants in the log line. */
  [key: string]: unknown;
}

/**
 * Record an audit-write failure to the structured log stream.
 *
 * Never throws — even when the input is `null`/`undefined`/non-Error —
 * so it is safe to use inside Promise rejection handlers and catch
 * blocks whose contract is "never crash the caller".
 */
export function recordAuditWriteFailure(
  err: unknown,
  context: AuditWriteFailureContext,
): void {
  try {
    const errorPayload =
      err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : { message: String(err), name: "NonErrorThrown" };

    log.error(AUDIT_WRITE_FAILED_MSG, {
      ...context,
      error: errorPayload,
    });
  } catch {
    // Defense-in-depth: if the logger itself fails (rare — would mean the
    // log transport is dead), still don't crash the request cycle. There
    // is nothing more we can do here without escalating the failure mode
    // beyond the original audit-write problem.
  }
}
