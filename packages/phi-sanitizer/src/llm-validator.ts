/**
 * LLM Response Validator — validates and sanitizes the JSON output
 * from the Claude clinical review before it enters the flag pipeline.
 *
 * Catches malformed JSON, invalid schemas, suspicious output, and
 * enforces output limits.
 */

const VALID_SEVERITIES = ["critical", "warning", "info"] as const;
const VALID_CATEGORIES = [
  "cross-specialty",
  "drug-interaction",
  "medication-safety",
  "care-gap",
  "critical-value",
  "trend-concern",
  "documentation-discrepancy",
] as const;

export const MAX_FLAGS = 50;

/**
 * Threshold at which a single LLM review's flag count is considered
 * "suspiciously high" and a warning is appended to the validation result.
 *
 * Originally 15 when MAX_FLAGS was 20 (see PR #493 history) — i.e. 75% of
 * cap, which reads as "the LLM is approaching the hard ceiling; something
 * may be off (prompt regression, prompt-injection probe, runaway model)."
 *
 * When MAX_FLAGS was raised 20 -> 50, this constant was left at 15, which
 * meant the warning fired at 30% of capacity. At that level a multi-system
 * oncology patient routinely trips the warning, drowning real signal in
 * noise (see issue #511).
 *
 * We re-peg the threshold to the original "near-cap" semantics at ~75%
 * of MAX_FLAGS. floor(50 * 0.75) = 37. Derived from MAX_FLAGS so future
 * cap changes automatically preserve the ratio; the suspicious-count
 * test asserts the numeric value to catch accidental drift.
 */
export const SUSPICIOUS_FLAG_THRESHOLD = Math.floor(MAX_FLAGS * 0.75);

/** Ordering used when a response overflows MAX_FLAGS: critical survive first. */
const SEVERITY_RANK: Record<(typeof VALID_SEVERITIES)[number], number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

export interface LLMFlag {
  severity: (typeof VALID_SEVERITIES)[number];
  category: (typeof VALID_CATEGORIES)[number];
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

/**
 * Structured record of an over-cap truncation. Present only when the LLM
 * returned more flags than MAX_FLAGS. Callers are expected to emit an
 * ALERT-level log when this is set so ops can tell when clinical signal
 * is being dropped rather than being quietly surfaced as a warning string.
 */
export interface TruncationInfo {
  receivedCount: number;
  keptCount: number;
  droppedCount: number;
  droppedBySeverity: Record<(typeof VALID_SEVERITIES)[number], number>;
}

export interface ValidationSuccess {
  ok: true;
  flags: LLMFlag[];
  warnings: string[];
  /** Set only when findings were dropped to stay under MAX_FLAGS. */
  truncation?: TruncationInfo;
}

export interface ValidationFailure {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Strip markdown code fences that LLMs sometimes wrap around JSON output.
 */
function stripCodeFences(raw: string): string {
  let text = raw.trim();
  // Remove ```json ... ``` or ``` ... ```
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    if (text.endsWith("```")) {
      text = text.slice(0, -3);
    }
    text = text.trim();
  }
  return text;
}

/**
 * Validate a single flag object has all required fields and valid values.
 */
function validateFlag(
  flag: Record<string, unknown>,
  index: number,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof flag.severity !== "string") {
    errors.push(`Flag[${index}]: missing or invalid "severity"`);
  } else if (
    !(VALID_SEVERITIES as readonly string[]).includes(flag.severity)
  ) {
    errors.push(
      `Flag[${index}]: invalid severity "${flag.severity}" (must be one of: ${VALID_SEVERITIES.join(", ")})`,
    );
  }

  if (typeof flag.category !== "string") {
    errors.push(`Flag[${index}]: missing or invalid "category"`);
  } else if (
    !(VALID_CATEGORIES as readonly string[]).includes(flag.category)
  ) {
    errors.push(
      `Flag[${index}]: invalid category "${flag.category}" (must be one of: ${VALID_CATEGORIES.join(", ")})`,
    );
  }

  if (typeof flag.summary !== "string" || flag.summary.trim().length === 0) {
    errors.push(`Flag[${index}]: missing or empty "summary"`);
  }

  if (
    typeof flag.rationale !== "string" ||
    flag.rationale.trim().length === 0
  ) {
    errors.push(`Flag[${index}]: missing or empty "rationale"`);
  }

  if (
    typeof flag.suggested_action !== "string" ||
    flag.suggested_action.trim().length === 0
  ) {
    errors.push(`Flag[${index}]: missing or empty "suggested_action"`);
  }

  if (!Array.isArray(flag.notify_specialties)) {
    errors.push(`Flag[${index}]: missing or invalid "notify_specialties"`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the raw LLM response string.
 * Strips code fences, parses JSON, validates schema, enforces limits.
 */
export function validateLLMResponse(raw: string): ValidationResult {
  const warnings: string[] = [];

  // Strip markdown code fences
  const cleaned = stripCodeFences(raw);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return {
      ok: false,
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Must be an array
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Response must be a JSON array",
    };
  }

  // Empty array is valid
  if (parsed.length === 0) {
    return { ok: true, flags: [], warnings };
  }

  // Validate each flag
  const allErrors: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null) {
      allErrors.push(`Flag[${i}]: must be an object`);
      continue;
    }
    const result = validateFlag(item as Record<string, unknown>, i);
    allErrors.push(...result.errors);
  }

  if (allErrors.length > 0) {
    return {
      ok: false,
      error: allErrors.join("; "),
    };
  }

  // Suspicious flag count
  if (parsed.length >= SUSPICIOUS_FLAG_THRESHOLD) {
    warnings.push(
      `Suspiciously high flag count: ${parsed.length} (threshold: ${SUSPICIOUS_FLAG_THRESHOLD})`,
    );
  }

  // Sort by severity before capping so critical findings survive a truncation.
  // Array.prototype.sort is stable in Node ≥ 12, so ordering within a severity
  // bucket matches the LLM's original output (preserves rank/tie-break intent).
  const all = [...(parsed as LLMFlag[])].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  // Cap at MAX_FLAGS
  const capped = all.slice(0, MAX_FLAGS);
  let truncation: TruncationInfo | undefined;
  if (all.length > MAX_FLAGS) {
    const dropped = all.slice(MAX_FLAGS);
    const droppedBySeverity: Record<
      (typeof VALID_SEVERITIES)[number],
      number
    > = { critical: 0, warning: 0, info: 0 };
    for (const f of dropped) {
      droppedBySeverity[f.severity]++;
    }
    truncation = {
      receivedCount: all.length,
      keptCount: capped.length,
      droppedCount: dropped.length,
      droppedBySeverity,
    };
    warnings.push(
      `Flag count ${all.length} exceeds maximum ${MAX_FLAGS}, truncated ` +
        `(dropped: critical=${droppedBySeverity.critical}, ` +
        `warning=${droppedBySeverity.warning}, info=${droppedBySeverity.info})`,
    );
    // Structured emission so log aggregators (Datadog, Loki, CloudWatch
    // Insights) can alert on truncation counts over time. Issue #510:
    // string-formatted alerts from the ai-oversight worker aren't reliably
    // parseable as a counter source. Consumers that wrap a metrics emitter
    // can still read `truncation` from the return value; this log is the
    // low-lift stopgap until a service-wide structured logger lands.
    console.warn(JSON.stringify({
      event: "llm_findings_truncated",
      received: all.length,
      kept: capped.length,
      dropped: dropped.length,
      droppedBySeverity,
      maxFlags: MAX_FLAGS,
    }));
  }

  return { ok: true, flags: capped, warnings, ...(truncation ? { truncation } : {}) };
}
