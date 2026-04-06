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
  "care-gap",
  "critical-value",
  "trend-concern",
  "documentation-discrepancy",
] as const;

const MAX_FLAGS = 20;
const SUSPICIOUS_FLAG_THRESHOLD = 15;

export interface LLMFlag {
  severity: (typeof VALID_SEVERITIES)[number];
  category: (typeof VALID_CATEGORIES)[number];
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

export interface ValidationSuccess {
  ok: true;
  flags: LLMFlag[];
  warnings: string[];
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

  // Cap at MAX_FLAGS
  const capped = parsed.slice(0, MAX_FLAGS) as LLMFlag[];
  if (parsed.length > MAX_FLAGS) {
    warnings.push(
      `Flag count ${parsed.length} exceeds maximum ${MAX_FLAGS}, truncated`,
    );
  }

  return { ok: true, flags: capped, warnings };
}
