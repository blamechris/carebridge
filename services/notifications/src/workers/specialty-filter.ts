/**
 * Specialty filtering for clinical-flag notification dispatch.
 *
 * HIPAA § 164.502(b) (minimum necessary rule) requires that clinical
 * alerts carrying PHI only reach providers whose role and specialty make
 * them a legitimate recipient for that flag. Clinical flags published by
 * the AI oversight engine attach a `notify_specialties` array that
 * identifies the specialty audiences the flag is relevant to. This module
 * applies that audience filter to a pre-fetched set of candidate
 * recipients, so the dispatch worker can stay a thin I/O shell and the
 * filter logic is independently unit-testable.
 *
 * Matching rules:
 *   * Comparison is case-insensitive.
 *   * `notify_specialties` entries and user `specialty` strings are split on
 *     whitespace, `/`, `,`, `&`, `|`, `-`, `(`, `)` so composite specialty
 *     labels like `"Hematology/Oncology"` correctly match `"oncology"` or
 *     `"hematology"`. This mirrors how clinicians actually self-identify
 *     vs. the lowercase tag lexicon used inside `CROSS_SPECIALTY_RULES`.
 *   * Admin-role users are always included, regardless of specialty. Admins
 *     are expected to see all clinical flags for oversight and cannot be
 *     excluded by a specialty scope.
 *   * When `notifySpecialties` is empty or null the filter returns every
 *     active candidate — legacy behaviour for flags that don't declare a
 *     target audience.
 *   * When `notifySpecialties` is non-empty and no candidate matches, the
 *     filter returns ONLY admin candidates (possibly empty). It must NOT
 *     silently fall back to the full care team — doing so re-discloses
 *     PHI to providers the flag was explicitly scoped away from.
 */

export interface CandidateRecipient {
  id: string;
  specialty: string | null;
  role: string;
}

const SPECIALTY_TOKEN_SPLIT = /[\s/,&|()\-]+/;

/**
 * Normalize a specialty label into a set of lower-case tokens.
 *
 * `"Hematology/Oncology"` → `{"hematology", "oncology"}`
 * `"Infectious Disease"` → `{"infectious", "disease", "infectious_disease"}`
 * `null`/empty → empty set
 *
 * The joined underscore variant exists so rule tags like `"infectious_disease"`
 * continue to match a user specialty of `"Infectious Disease"`.
 */
function tokenizeSpecialty(value: string | null | undefined): Set<string> {
  if (value == null) return new Set();
  const lower = value.toLowerCase().trim();
  if (lower.length === 0) return new Set();

  const tokens = new Set<string>();
  // Whole-string variants (normalized underscores / spaces)
  tokens.add(lower);
  tokens.add(lower.replace(/_/g, " "));
  tokens.add(lower.replace(/\s+/g, "_"));

  // Individual tokens
  for (const part of lower.split(SPECIALTY_TOKEN_SPLIT)) {
    if (part.length > 0) tokens.add(part);
  }
  return tokens;
}

/**
 * Returns true when any token in `candidateTokens` appears in
 * `requestedTokens` (set intersection is non-empty).
 */
function tokensIntersect(
  candidateTokens: Set<string>,
  requestedTokens: Set<string>,
): boolean {
  for (const token of candidateTokens) {
    if (requestedTokens.has(token)) return true;
  }
  return false;
}

/**
 * Filter a set of candidate recipients down to the user IDs that should
 * receive a clinical-flag notification, based on the flag's declared
 * `notify_specialties` audience.
 *
 * See module-level docstring for matching rules.
 */
export function filterRecipientsBySpecialty(
  candidates: readonly CandidateRecipient[],
  notifySpecialties: readonly string[] | null | undefined,
): string[] {
  // No specialty targeting → notify everyone in the candidate set.
  if (notifySpecialties == null || notifySpecialties.length === 0) {
    return candidates.map((c) => c.id);
  }

  // Build the union token set for the flag's requested specialties.
  const requestedTokens = new Set<string>();
  for (const spec of notifySpecialties) {
    for (const token of tokenizeSpecialty(spec)) {
      requestedTokens.add(token);
    }
  }

  // If every entry was empty after normalization, degenerate to
  // "no targeting" rather than silently dropping all recipients.
  if (requestedTokens.size === 0) {
    return candidates.map((c) => c.id);
  }

  const matched: string[] = [];
  for (const candidate of candidates) {
    // Admins always receive flags, regardless of specialty scope.
    if (candidate.role === "admin") {
      matched.push(candidate.id);
      continue;
    }
    const candidateTokens = tokenizeSpecialty(candidate.specialty);
    if (candidateTokens.size === 0) continue;
    if (tokensIntersect(candidateTokens, requestedTokens)) {
      matched.push(candidate.id);
    }
  }

  return matched;
}
