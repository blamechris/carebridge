/**
 * Named constants and helpers for formatting clinical reference ranges.
 *
 * Extracted from the LabsTab in `app/patients/[id]/page.tsx` so that
 * display-level Unicode characters (en-dash, em-dash) are defined once
 * and unit-testable rather than scattered as inline literals.
 */

/** En-dash used between low and high bounds of a reference range. */
export const RANGE_SEPARATOR = '\u2013';

/** Em-dash shown when no reference range is available. */
export const NO_VALUE = '\u2014';

/**
 * Format a lab reference range for display.
 *
 * - Both bounds present: "low\u2013high"
 * - Only low:            "> low"
 * - Only high:           "< high"
 * - Neither:             "\u2014" (em-dash, meaning "not applicable")
 */
export function formatReferenceRange(
  low?: number | null,
  high?: number | null,
): string {
  if (typeof low === 'number' && typeof high === 'number') {
    return `${low}${RANGE_SEPARATOR}${high}`;
  }
  if (typeof low === 'number') {
    return `> ${low}`;
  }
  if (typeof high === 'number') {
    return `< ${high}`;
  }
  return NO_VALUE;
}
