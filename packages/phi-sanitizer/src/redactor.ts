/**
 * PHI Redactor — strips protected health information before sending context
 * to the LLM layer. Produces a rehydration map so the AI oversight engine
 * can inject real names back into the final clinical flag text.
 */

export interface RedactionResult {
  redactedText: string;
  tokenMap: Map<string, string>;
  auditTrail: AuditTrail;
}

export interface AuditTrail {
  fieldsRedacted: number;
  providersRedacted: number;
  agesRedacted: number;
  freeTextSanitized: number;
}

// ChatML / Llama delimiter patterns that could be used for injection
const INJECTION_PATTERNS = [
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|system\|>/g,
  /<\|user\|>/g,
  /<\|assistant\|>/g,
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<<SYS>>/g,
  /<<\/SYS>>/g,
  /<\|endoftext\|>/g,
  /<\|padding\|>/g,
];

// Control characters (except newline, tab, carriage return)
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Band an age into a privacy-safe range.
 * e.g., 62 → "early 60s", 45 → "mid 40s", 78 → "late 70s"
 */
export function bandAge(age: number): string {
  if (age < 1) return "infant";
  if (age < 3) return "toddler";
  if (age < 13) return "child";
  if (age < 18) return "adolescent";

  const decade = Math.floor(age / 10) * 10;
  const offset = age % 10;

  if (offset <= 3) return `early ${decade}s`;
  if (offset <= 6) return `mid ${decade}s`;
  return `late ${decade}s`;
}

/**
 * Sanitize free text by stripping control characters and injection patterns.
 */
export function sanitizeFreeText(text: string): string {
  let cleaned = text.replace(CONTROL_CHARS, "");
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[FILTERED]");
  }
  return cleaned;
}

/**
 * Redact provider names from clinical text, replacing them with
 * numbered tokens like [PROVIDER-1], [PROVIDER-2], etc.
 *
 * Returns the redacted text plus a token map for rehydration.
 */
export function redactProviderNames(
  text: string,
  providerNames: string[],
): { redactedText: string; tokenMap: Map<string, string> } {
  const tokenMap = new Map<string, string>();
  let result = text;
  let counter = 1;

  // Sort by length descending so "Dr. Sarah Smith" is matched before "Smith"
  const sorted = [...providerNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    if (!name || name.trim().length === 0) continue;
    const token = `[PROVIDER-${counter}]`;
    // Escape special regex characters in the name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    if (regex.test(result)) {
      result = result.replace(regex, token);
      tokenMap.set(token, name);
      counter++;
    }
  }

  return { redactedText: result, tokenMap };
}

/**
 * Rehydrate tokens back to real names using a token map.
 */
export function rehydrate(
  text: string,
  tokenMap: Map<string, string>,
): string {
  let result = text;
  for (const [token, realName] of tokenMap) {
    result = result.replaceAll(token, realName);
  }
  return result;
}

/**
 * Redact clinical age shorthand patterns for a specific patient age in free text.
 * Handles patterns like: 62yo, 62 yo, 62y/o, 62 y/o, 62-year-old, 62 year old,
 * 62 years old.
 *
 * Only redacts occurrences of the exact patient age to avoid redacting
 * unrelated ages (e.g., "prescribed for patients 18-65").
 */
export function redactAgeInFreeText(text: string, age: number): string {
  const ageStr = String(age);
  const banded = bandAge(age);

  // Build pattern matching all clinical shorthand forms for the specific age.
  // Order matters: longer patterns first to avoid partial matches.
  // Patterns matched (all case-insensitive):
  //   62-year-old, 62 year-old, 62-year old, 62 year old
  //   62 years old
  //   62y/o, 62 y/o
  //   62yo, 62 yo
  const pattern = new RegExp(
    `\\b${ageStr}(?:` +
      `[- ]?years?[- ]?old` +  // year-old / year old / years old variants
      `|\\s?y\\/o` +            // y/o with optional space
      `|\\s?yo` +               // yo with optional space
    `)\\b`,
    "gi",
  );

  return text.replace(pattern, banded);
}

/**
 * Full redaction pipeline: sanitize free text, redact provider names,
 * band ages, and produce an audit trail.
 */
export function redactClinicalText(
  text: string,
  options: {
    providerNames?: string[];
    patientAge?: number;
  } = {},
): RedactionResult {
  const audit: AuditTrail = {
    fieldsRedacted: 0,
    providersRedacted: 0,
    agesRedacted: 0,
    freeTextSanitized: 0,
  };

  // Step 1: sanitize free text
  const sanitized = sanitizeFreeText(text);
  if (sanitized !== text) {
    audit.freeTextSanitized++;
  }

  // Step 2: redact provider names
  let current = sanitized;
  let tokenMap = new Map<string, string>();

  if (options.providerNames && options.providerNames.length > 0) {
    const result = redactProviderNames(current, options.providerNames);
    current = result.redactedText;
    tokenMap = result.tokenMap;
    audit.providersRedacted = tokenMap.size;
  }

  // Step 3: redact patient age shorthand patterns in free text
  if (options.patientAge !== undefined) {
    const before = current;
    current = redactAgeInFreeText(current, options.patientAge);
    if (current !== before) {
      audit.agesRedacted++;
    }
  }

  audit.fieldsRedacted =
    audit.providersRedacted + audit.agesRedacted + audit.freeTextSanitized;

  return {
    redactedText: current,
    tokenMap,
    auditTrail: audit,
  };
}
