import { createLogger } from "@carebridge/logger";

const logger = createLogger("ai-oversight");

/**
 * Validate and normalize a ClinicalEvent.timestamp before it is used as the
 * right-hand side of a snapshot comparison inside a context builder.
 *
 * Background — #517 (follow-up to PR #494): both rule and LLM context builders
 * filter the patient record "as of event time". When `event.timestamp` is
 * `undefined`, an empty string, or a malformed string, the lexicographic
 * comparisons (`row.created_at <= eventAt`) become silently wrong: either
 * everything is excluded or everything is included. Clinical flags then fire
 * against a nonsense snapshot, which is a safety hazard.
 *
 * Fallback strategy — log a structured warning (with event id only, no PHI)
 * and substitute the current time (`new Date().toISOString()`). This keeps
 * the review moving for events whose timestamp happens to be garbage, rather
 * than failing the review entirely and risking a missed safety signal while
 * BullMQ retries the job forever. The trade-off is documented in the PR that
 * introduced this helper.
 *
 * Cases detected:
 *   1. `undefined` / empty / whitespace-only timestamp
 *   2. Unparseable string (`Date.parse` returns `NaN`)
 *   3. Future timestamp more than 1 minute past `now` (clock-skew sentinel)
 *   4. Implausibly old timestamp (before 2000-01-01) — guards against epoch
 *      values leaking through from default-initialized records
 */

export interface ValidateEventTimestampOptions {
  /**
   * Identifier of the event whose timestamp is being validated. Logged on
   * fallback so operators can correlate the warning with a specific queue
   * entry. Safe to include (event id is not PHI).
   */
  eventId?: string;
  /**
   * Label of the context builder doing the validation. Included in the log
   * prefix so the same helper can be used from multiple call sites.
   */
  caller?: string;
  /**
   * Hook for tests — injects a synthetic "now" so the clock-skew branch is
   * reachable without real-time plumbing. Defaults to `Date.now()`.
   */
  now?: () => number;
}

const MINUTE_MS = 60 * 1000;
const YEAR_2000_MS = Date.UTC(2000, 0, 1);
const CLOCK_SKEW_GRACE_MS = MINUTE_MS;

/**
 * Returns a known-good ISO-8601 string. If the input fails any check, a
 * warning is logged and the current time (from `options.now` or the system
 * clock) is returned instead.
 */
export function validateEventTimestamp(
  ts: string | undefined,
  options: ValidateEventTimestampOptions = {},
): string {
  const nowMs = (options.now ?? (() => Date.now()))();
  const caller = options.caller ?? "event-timestamp";
  const eventId = options.eventId ?? "unknown";

  const fallback = (reason: string, value: unknown): string => {
    const iso = new Date(nowMs).toISOString();
    logger.warn("timestamp_fallback_total", {
      metric: "timestamp_fallback_total",
      caller,
      eventId,
      reason,
      value: JSON.stringify(value),
      fallbackTimestamp: iso,
    });
    return iso;
  };

  if (ts === undefined || ts === null) {
    return fallback("missing", ts ?? null);
  }

  if (typeof ts !== "string") {
    return fallback("not-a-string", ts);
  }

  if (ts.trim().length === 0) {
    return fallback("empty", ts);
  }

  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    return fallback("unparseable", ts);
  }

  if (parsed < YEAR_2000_MS) {
    return fallback("too-old", ts);
  }

  if (parsed > nowMs + CLOCK_SKEW_GRACE_MS) {
    return fallback("future", ts);
  }

  return ts;
}
