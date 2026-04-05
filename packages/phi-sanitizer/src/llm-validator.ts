/**
 * LLM Output Validator — strict Zod schema validation for Claude API responses.
 *
 * The safety gap: without validation, any string Claude returns gets cast
 * directly into the clinical record. This module enforces:
 *   1. Valid JSON structure
 *   2. Enum membership for severity and category
 *   3. Length bounds on all text fields
 *   4. Array type on notify_specialties
 *   5. Required fields present and non-empty
 *
 * On parse failure, returns a ValidationFailure rather than silently returning [].
 * The caller can then decide to log, alert, or fall back to rules-only.
 */

import { z } from "zod";

const VALID_SEVERITIES = ["critical", "warning", "info"] as const;
const VALID_CATEGORIES = [
  "cross-specialty",
  "drug-interaction",
  "care-gap",
  "critical-value",
  "trend-concern",
  "documentation-discrepancy",
] as const;

const LLMFlagSchema = z.object({
  severity: z.enum(VALID_SEVERITIES, {
    errorMap: () => ({ message: `severity must be one of: ${VALID_SEVERITIES.join(", ")}` }),
  }),
  category: z.enum(VALID_CATEGORIES, {
    errorMap: () => ({ message: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }),
  }),
  summary: z.string().min(1).max(500),
  rationale: z.string().min(1).max(2000),
  suggested_action: z.string().min(1).max(1000),
  notify_specialties: z.array(z.string().max(100)).default([]),
});

const LLMResponseSchema = z.array(LLMFlagSchema).max(20, {
  message: "Suspiciously high flag count — possible hallucination, capped at 20",
});

export type ValidatedFlag = z.infer<typeof LLMFlagSchema>;

export type ValidationResult =
  | { ok: true; flags: ValidatedFlag[] }
  | { ok: false; error: string; rawResponse: string };

/**
 * Parse and validate Claude's clinical review response.
 *
 * Unlike the previous `parseReviewResponse` which silently returned [] on any
 * error, this function returns a typed result so the caller can distinguish
 * "LLM found nothing" from "LLM response was invalid".
 */
export function validateLLMResponse(rawResponse: string): ValidationResult {
  // Strip markdown code fences if present (Claude sometimes wraps JSON)
  const stripped = rawResponse
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  // Attempt JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      rawResponse: rawResponse.slice(0, 500), // truncate for logging
    };
  }

  // Handle the case where Claude returns an empty array explicitly
  if (Array.isArray(parsed) && parsed.length === 0) {
    return { ok: true, flags: [] };
  }

  // Validate against schema
  const result = LLMResponseSchema.safeParse(parsed);
  if (!result.success) {
    const errorMsg = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");

    return {
      ok: false,
      error: `Schema validation failed: ${errorMsg}`,
      rawResponse: rawResponse.slice(0, 500),
    };
  }

  return { ok: true, flags: result.data };
}

/**
 * Plausibility check: does the flag count seem reasonable?
 * A patient with 15+ critical flags in a single review pass is a red flag for hallucination.
 */
export function isSuspiciousFlagCount(flags: ValidatedFlag[]): boolean {
  const criticalCount = flags.filter((f) => f.severity === "critical").length;
  return flags.length > 10 || criticalCount > 5;
}
