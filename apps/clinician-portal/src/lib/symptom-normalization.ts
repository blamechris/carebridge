/**
 * Shared symptom-label normalisation + NS↔ROS matching helpers.
 *
 * Issue #1314 — the original auto-mirror in `apps/clinician-portal/app/
 * notes/new/page.tsx` did an exact case-insensitive suffix match. That
 * silently dropped pairings like NS "vision changes" ↔ ROS "eyes: vision
 * change" because of plural/singular drift. We centralise the naive
 * trailing-"s" strip the symptom-suggestion-banner already uses for
 * detection, and apply it to BOTH sides of the comparison.
 *
 * Naming: "naive" is intentional — this is not a real stemmer, just the
 * minimum normalisation that handles the common plural/singular spelling
 * drift seen in the curated symptom catalog.
 *
 * Matching contract:
 *
 *   1. Exact (post-lowercase + trim) matches always win over a
 *      normalised match. This avoids the surprise of an exactly-spelled
 *      symptom getting overridden by a plural-stripped near-match.
 *   2. When multiple options normalise to the same form, return the
 *      first occurrence deterministically — preserving the curated
 *      ordering in the catalog.
 *   3. Unknown symptoms return `undefined` so callers can gracefully
 *      skip the auto-mirror step.
 */

import { parseROSOption } from "./symptom-systems";

/**
 * Lowercase, trim, and strip a single trailing "s" if present.
 *
 * This is the same normalisation the symptom-suggestion-banner uses to
 * tolerate the "headache"/"headaches" split. It is single-pass — "kiss"
 * becomes "kis" rather than "k" — because the catalog never spells a
 * symptom with multiple trailing "s"es in a way we care about, and
 * being non-recursive keeps the helper unambiguous.
 */
export function normalizeSymptomLabel(s: string): string {
  const lower = s.toLowerCase().trim();
  if (lower.length > 1 && lower.endsWith("s")) {
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * Find the first ROS option whose post-colon suffix matches the supplied
 * NS symptom string. Prefers an exact match (post-lowercase + trim) over
 * a normalised match — the latter is the plural-tolerant fallback.
 *
 * Returns `undefined` when no option matches under either rule.
 */
export function findROSOptionForSymptom(
  symptom: string,
  rosOptions: string[],
): string | undefined {
  const exactNeedle = symptom.toLowerCase().trim();
  const normalNeedle = normalizeSymptomLabel(symptom);

  // First pass: exact match wins.
  for (const opt of rosOptions) {
    const { symptom: suffix } = parseROSOption(opt);
    if (suffix.toLowerCase().trim() === exactNeedle) return opt;
  }
  // Second pass: normalised match handles plural/singular drift.
  for (const opt of rosOptions) {
    const { symptom: suffix } = parseROSOption(opt);
    if (normalizeSymptomLabel(suffix) === normalNeedle) return opt;
  }
  return undefined;
}

/**
 * Reverse direction: given a ROS option, find the matching NS option
 * whose bare label corresponds. NS options are unprefixed strings so
 * the comparison is a direct label match (with the same normalisation).
 */
export function findNSOptionForROS(
  rosOption: string,
  nsOptions: string[],
): string | undefined {
  const { symptom } = parseROSOption(rosOption);
  const exactNeedle = symptom.toLowerCase().trim();
  const normalNeedle = normalizeSymptomLabel(symptom);

  for (const opt of nsOptions) {
    if (opt.toLowerCase().trim() === exactNeedle) return opt;
  }
  for (const opt of nsOptions) {
    if (normalizeSymptomLabel(opt) === normalNeedle) return opt;
  }
  return undefined;
}
