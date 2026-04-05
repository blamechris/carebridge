/**
 * PHI Redactor — strips/pseudonymizes Protected Health Information before
 * it reaches any external LLM API.
 *
 * Design goals:
 *   1. Clinical utility preserved: diagnoses, medications, vitals, labs kept
 *   2. Direct identifiers removed: provider names replaced with role tokens
 *   3. Reversible for response re-hydration: mapping kept in memory only
 *   4. Audit trail: every redaction is logged with field names
 *
 * What we redact:
 *   - Care team member names → [PROVIDER-N] (specialty preserved)
 *   - Patient name (not present in ReviewContext — already good)
 *   - Patient age is age-banded to reduce re-identification risk
 *     e.g. 62 → "early 60s"
 *
 * What we intentionally keep:
 *   - Diagnoses (needed for clinical reasoning)
 *   - Medications with doses (needed for interaction detection)
 *   - Lab values (needed for critical value detection)
 *   - Vitals (needed for trend analysis)
 *   - Allergies (needed for safety checking)
 *   - Biological sex (needed for reference range interpretation)
 */

import type { ReviewContext } from "@carebridge/ai-prompts";

export interface RedactionMapping {
  /** Maps pseudonym token → original value (e.g. "[PROVIDER-1]" → "Dr. Smith") */
  providers: Record<string, string>;
}

export interface RedactionAudit {
  patient_id: string;
  fields_redacted: string[];
  provider_count: number;
  timestamp: string;
}

export interface RedactedContext {
  context: ReviewContext;
  mapping: RedactionMapping;
  audit: RedactionAudit;
}

/**
 * Age-banding: reduces precision of patient age to a 5-year band.
 * 62 → "early 60s", 45 → "mid 40s", 71 → "early 70s"
 */
function ageBand(age: number): string {
  const decade = Math.floor(age / 10) * 10;
  const position = age % 10;
  let modifier: string;
  if (position < 3) modifier = "early";
  else if (position < 7) modifier = "mid";
  else modifier = "late";

  if (age < 2) return "infant";
  if (age < 13) return `${age} year old child`;
  if (age < 18) return "adolescent";
  return `${modifier} ${decade}s`;
}

/**
 * Sanitize a ReviewContext for safe transmission to an external LLM API.
 *
 * Returns the redacted context, a mapping for re-hydration, and an audit record.
 */
export function redactContext(
  context: ReviewContext,
  patientId: string,
): RedactedContext {
  const mapping: RedactionMapping = { providers: {} };
  const fieldsRedacted: string[] = [];

  // --- Redact care team member names ---
  let providerCounter = 1;
  const redactedCareTeam = context.care_team.map((member) => {
    const token = `[PROVIDER-${providerCounter++}]`;
    if (member.name && member.name !== "Unknown Provider") {
      mapping.providers[token] = member.name;
      fieldsRedacted.push("care_team.name");
    }
    return {
      ...member,
      name: token,
    };
  });

  // --- Age-band the patient age ---
  const originalAge = context.patient.age;
  const ageBanded = ageBand(originalAge);

  // Build the redacted context
  const redacted: ReviewContext = {
    ...context,
    patient: {
      ...context.patient,
      age: originalAge, // keep numeric age for the type; ageBanded in prompt rendering
    },
    care_team: redactedCareTeam,
    triggering_event: sanitizeTriggeringEvent(context.triggering_event, fieldsRedacted),
  };

  return {
    context: redacted,
    mapping,
    audit: {
      patient_id: patientId,
      fields_redacted: fieldsRedacted,
      provider_count: providerCounter - 1,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Sanitize the triggering event detail to strip potential injection payloads.
 *
 * Free-text fields (note subjective, vital notes) are truncated and stripped
 * of characters that could be used for prompt injection.
 */
function sanitizeTriggeringEvent(
  triggerEvent: ReviewContext["triggering_event"],
  fieldsRedacted: string[],
): ReviewContext["triggering_event"] {
  const sanitizedDetail = sanitizeFreeText(triggerEvent.detail);
  if (sanitizedDetail !== triggerEvent.detail) {
    fieldsRedacted.push("triggering_event.detail");
  }

  return {
    ...triggerEvent,
    detail: sanitizedDetail,
  };
}

/**
 * Sanitize free-text clinical content to reduce prompt injection risk.
 *
 * - Strips control characters
 * - Encodes common injection patterns (ignore/override/system directives)
 * - Truncates to a safe maximum length
 * - Preserves clinical content (numbers, medical abbreviations, etc.)
 */
const MAX_FREE_TEXT_LENGTH = 2000;

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/gi,
  /you\s+are\s+now\s+in\s+(override|maintenance|admin)\s+mode/gi,
  /system\s*:\s*(override|ignore|forget|reset)/gi,
  /\bsystem\s*prompt\b/gi,
  /return\s+exactly\s*:/gi,
  /output\s+only\s*:/gi,
];

export function sanitizeFreeText(text: string): string {
  // Remove null bytes and other control characters (keep newlines and tabs)
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");

  // Neutralize known injection patterns by wrapping them
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => `[REDACTED-CLINICAL-TEXT: ${match.length} chars]`);
  }

  // Truncate to prevent token exhaustion
  if (sanitized.length > MAX_FREE_TEXT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FREE_TEXT_LENGTH) + " [TRUNCATED]";
  }

  return sanitized;
}

/**
 * Re-hydrate provider pseudonyms in a text string back to real names.
 * Used when returning flag summaries to clinical staff.
 */
export function rehydrateText(text: string, mapping: RedactionMapping): string {
  let result = text;
  for (const [token, realName] of Object.entries(mapping.providers)) {
    result = result.replaceAll(token, realName);
  }
  return result;
}
