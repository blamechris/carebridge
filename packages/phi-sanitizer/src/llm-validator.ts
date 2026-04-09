/**
 * LLM Response Validator — validates and sanitizes the JSON output
 * from the Claude clinical review before it enters the flag pipeline.
 *
 * Catches malformed JSON, invalid schemas, suspicious output, enforces
 * output limits, and (Phase D P1) rejects individual flags whose free-text
 * fields contain PHI-shaped patterns. A PHI-bearing response is the
 * signature of either LLM hallucination of real-looking identifiers or,
 * more worryingly, training-data leakage; neither should land in a
 * clinician's inbox.
 */

import { SANITIZATION_GUARDS } from "./redactor.js";

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

const MAX_FLAGS = 20;
const SUSPICIOUS_FLAG_THRESHOLD = 15;

/**
 * Scan a string for any residual PHI pattern. Reuses the same guard list
 * the outbound assertPromptSanitized() check uses, so a pattern we refuse
 * to SEND is also a pattern we refuse to RECEIVE back from the LLM.
 *
 * Returns the list of violation labels (NOT the matching text) so callers
 * can log diagnostics without re-leaking PHI.
 */
function scanForPhiPatterns(text: string): string[] {
  const violations: string[] = [];
  for (const { label, pattern } of SANITIZATION_GUARDS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) violations.push(label);
  }
  return violations;
}

/**
 * Scan every free-text field of a flag for PHI. Returns an empty array
 * if the flag is clean.
 */
function scanFlagForPhi(flag: {
  summary: unknown;
  rationale: unknown;
  suggested_action: unknown;
}): string[] {
  const violations = new Set<string>();
  const fields: Array<{ name: string; value: unknown }> = [
    { name: "summary", value: flag.summary },
    { name: "rationale", value: flag.rationale },
    { name: "suggested_action", value: flag.suggested_action },
  ];
  for (const { name, value } of fields) {
    if (typeof value !== "string") continue;
    for (const v of scanForPhiPatterns(value)) {
      violations.add(`${name}:${v}`);
    }
  }
  return Array.from(violations);
}

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

  // Phase D P1: scan free-text fields of each flag for residual PHI
  // patterns. Drop any flag that looks like it contains leaked identifiers
  // and warn. We keep the rest — a single contaminated flag should not
  // suppress the other findings from the same batch.
  const clean: LLMFlag[] = [];
  for (let i = 0; i < capped.length; i++) {
    const flag = capped[i];
    const violations = scanFlagForPhi(flag);
    if (violations.length > 0) {
      warnings.push(
        `Flag[${i}] dropped due to residual PHI patterns: ${violations.join(", ")}`,
      );
      continue;
    }
    clean.push(flag);
  }

  return { ok: true, flags: clean, warnings };
}
