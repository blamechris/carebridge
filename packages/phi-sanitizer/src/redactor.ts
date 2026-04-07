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
  patientNamesRedacted: number;
  mrnsRedacted: number;
  datesRedacted: number;
  facilitiesRedacted: number;
  phonesRedacted: number;
  addressesRedacted: number;
}

const MRN_LABELED = /\bMRN[:\s#]*\d{6,12}\b/gi;
const MRN_CONTEXT = /\b(?:patient|pt|medical\s+record|record|id)\s*(?:#|number|no\.?|:)?\s*(\d{7,10})\b/gi;
const DATE_MDY = /\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](\d{4}|\d{2})\b/g;
const DATE_ISO = /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const DATE_MONTH_NAME =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}\b/gi;
const PHONE_PAREN = /\(\d{3}\)\s*\d{3}-\d{4}/g;
const PHONE_DASH = /\b\d{3}-\d{3}-\d{4}\b/g;
const PHONE_SHORT = /\b\d{3}-\d{4}\b/g;
const ADDRESS = /\b\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Way)\b\.?/g;

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
 * Redact a single patient name (case-insensitive) and simple variants.
 * Also redacts individual name tokens (first/last) when the full name has
 * 2+ parts, so references like "Ms. Doe" or "John's labs" are covered.
 */
export function redactPatientName(text: string, patientName: string): { redactedText: string; count: number } {
  if (!patientName || patientName.trim().length === 0) {
    return { redactedText: text, count: 0 };
  }
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = patientName.trim().split(/\s+/).filter((p) => p.length >= 2);
  // Longest first so full name matches before single-token matches
  const candidates = [patientName.trim(), ...parts].sort((a, b) => b.length - a.length);
  let result = text;
  let count = 0;
  const seen = new Set<string>();
  for (const cand of candidates) {
    const key = cand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const regex = new RegExp(`\\b${escape(cand)}\\b`, "gi");
    const matches = result.match(regex);
    if (matches && matches.length > 0) {
      result = result.replace(regex, "[PATIENT]");
      count += matches.length;
    }
  }
  return { redactedText: result, count };
}

/**
 * Redact MRN patterns (labeled and context-based).
 */
export function redactMRN(text: string): { redactedText: string; count: number } {
  let count = 0;
  let result = text.replace(MRN_LABELED, () => {
    count++;
    return "[MRN]";
  });
  result = result.replace(MRN_CONTEXT, (match, digits, offset: number, full: string) => {
    // Avoid double-replacing content already inside a [MRN] token
    const prefix = match.slice(0, match.length - String(digits).length);
    count++;
    return `${prefix}[MRN]`;
  });
  return { redactedText: result, count };
}

/**
 * Redact specific date formats with a relative "[DATE]" marker. If a
 * referenceDate is provided, substitute "[N days ago]" when the match
 * parses to a real date in the past.
 */
export function redactDates(
  text: string,
  referenceDate?: Date,
): { redactedText: string; count: number } {
  let count = 0;
  const replaceWith = (matched: string): string => {
    count++;
    if (!referenceDate) return "[DATE]";
    const parsed = new Date(matched);
    if (isNaN(parsed.getTime())) return "[DATE]";
    const days = Math.floor(
      (referenceDate.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000),
    );
    if (days < 0) return "[DATE]";
    if (days === 0) return "[today]";
    return `[${days} days ago]`;
  };

  let result = text.replace(DATE_ISO, (m) => replaceWith(m));
  result = result.replace(DATE_MONTH_NAME, (m) => replaceWith(m));
  result = result.replace(DATE_MDY, (m) => replaceWith(m));
  return { redactedText: result, count };
}

/**
 * Redact facility names (case-insensitive, exact substring match).
 */
export function redactFacilityNames(
  text: string,
  facilityNames: string[],
): { redactedText: string; count: number } {
  let result = text;
  let count = 0;
  const sorted = [...facilityNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (!name || name.trim().length === 0) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    const matches = result.match(regex);
    if (matches && matches.length > 0) {
      result = result.replace(regex, "[FACILITY]");
      count += matches.length;
    }
  }
  return { redactedText: result, count };
}

/**
 * Redact US phone numbers.
 */
export function redactPhones(text: string): { redactedText: string; count: number } {
  let count = 0;
  let result = text.replace(PHONE_PAREN, () => {
    count++;
    return "[PHONE]";
  });
  result = result.replace(PHONE_DASH, () => {
    count++;
    return "[PHONE]";
  });
  result = result.replace(PHONE_SHORT, () => {
    count++;
    return "[PHONE]";
  });
  return { redactedText: result, count };
}

/**
 * Redact simple US street addresses.
 */
export function redactAddresses(text: string): { redactedText: string; count: number } {
  let count = 0;
  const result = text.replace(ADDRESS, () => {
    count++;
    return "[ADDRESS]";
  });
  return { redactedText: result, count };
}

/**
 * Error thrown when a prompt fails the fail-closed PHI sanitization check.
 * Carries a list of violation labels (NOT the matching text) so callers can
 * log diagnostics without re-leaking PHI.
 */
export class SanitizationError extends Error {
  public readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `Prompt failed fail-closed PHI sanitization: ${violations.length} violation(s) [${violations.join(", ")}]`,
    );
    this.name = "SanitizationError";
    this.violations = violations;
  }
}

const SANITIZATION_GUARDS: Array<{ label: string; pattern: RegExp }> = [
  { label: "MRN_LABELED", pattern: MRN_LABELED },
  { label: "DATE_ISO", pattern: DATE_ISO },
  { label: "DATE_MDY", pattern: DATE_MDY },
  { label: "DATE_MONTH_NAME", pattern: DATE_MONTH_NAME },
  { label: "PHONE_PAREN", pattern: PHONE_PAREN },
  { label: "PHONE_DASH", pattern: PHONE_DASH },
  { label: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "ADDRESS", pattern: ADDRESS },
];

/**
 * Fail-closed assertion that a prompt has been redacted before being sent
 * to an external LLM. Throws SanitizationError if any residual PHI-shaped
 * pattern is detected. The error message never contains the matched text.
 */
export function assertPromptSanitized(text: string): void {
  const violations: string[] = [];
  for (const { label, pattern } of SANITIZATION_GUARDS) {
    // Reset stateful regex
    pattern.lastIndex = 0;
    if (pattern.test(text)) violations.push(label);
  }
  if (violations.length > 0) {
    throw new SanitizationError(violations);
  }
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
    patientName?: string;
    facilityNames?: string[];
    referenceDate?: Date;
  } = {},
): RedactionResult {
  const audit: AuditTrail = {
    fieldsRedacted: 0,
    providersRedacted: 0,
    agesRedacted: 0,
    freeTextSanitized: 0,
    patientNamesRedacted: 0,
    mrnsRedacted: 0,
    datesRedacted: 0,
    facilitiesRedacted: 0,
    phonesRedacted: 0,
    addressesRedacted: 0,
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

  // Step 4: redact patient name
  if (options.patientName) {
    const r = redactPatientName(current, options.patientName);
    current = r.redactedText;
    audit.patientNamesRedacted = r.count;
  }

  // Step 5: redact facility names
  if (options.facilityNames && options.facilityNames.length > 0) {
    const r = redactFacilityNames(current, options.facilityNames);
    current = r.redactedText;
    audit.facilitiesRedacted = r.count;
  }

  // Step 6: redact MRNs
  {
    const r = redactMRN(current);
    current = r.redactedText;
    audit.mrnsRedacted = r.count;
  }

  // Step 7: redact specific dates
  {
    const r = redactDates(current, options.referenceDate);
    current = r.redactedText;
    audit.datesRedacted = r.count;
  }

  // Step 8: redact phone numbers
  {
    const r = redactPhones(current);
    current = r.redactedText;
    audit.phonesRedacted = r.count;
  }

  // Step 9: redact addresses
  {
    const r = redactAddresses(current);
    current = r.redactedText;
    audit.addressesRedacted = r.count;
  }

  audit.fieldsRedacted =
    audit.providersRedacted +
    audit.agesRedacted +
    audit.freeTextSanitized +
    audit.patientNamesRedacted +
    audit.mrnsRedacted +
    audit.datesRedacted +
    audit.facilitiesRedacted +
    audit.phonesRedacted +
    audit.addressesRedacted;

  return {
    redactedText: current,
    tokenMap,
    auditTrail: audit,
  };
}
