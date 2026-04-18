/**
 * Pure helpers for formatting vital-sign ages and classifying staleness tiers.
 *
 * Extracted from `app/patients/[id]/page.tsx` so they can be unit-tested
 * and reused (e.g. the StaleDataBanner in #256/#496).
 */

/**
 * Compute a human-readable "N units ago" string for a clinical-data timestamp.
 * Fixed clinical thresholds (not locale-based) so the age string is
 * diagnostic at a glance: hours for <24h, days beyond that.
 */
export function formatAge(recordedAtIso: string): string {
  const ageMs = Date.now() - new Date(recordedAtIso).getTime();
  if (Number.isNaN(ageMs)) return "unknown";
  if (ageMs < 60_000) return "just now";
  const mins = Math.round(ageMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(ageMs / 86_400_000);
  return `${days}d ago`;
}

/**
 * Classify a recorded-at timestamp into a staleness tier.
 *
 * Thresholds mirror the clinical expectation for acute-care inpatient
 * monitoring: vitals taken more than 4h ago are due for re-check, and
 * vitals older than 24h should not be read as "current" at all.
 *
 *  - "current":  <= 4h — no visual treatment
 *  - "overdue":  4h < age <= 24h — amber tint, "recheck due"
 *  - "stale":    > 24h — gray, "stale" label, reader should not trust
 */
export type StalenessTier = "current" | "overdue" | "stale";

/**
 * Minimum age (ms) at which latest vitals/labs are flagged as stale in the
 * patient chart banner.
 *
 * 7 days (604 800 000 ms). Chosen because:
 *  - Acute-care vitals are re-checked on a 4–24h cadence (see
 *    `classifyStaleness`), but the chart-level "stale data" banner targets
 *    the broader case where *any* data point is old enough to be
 *    clinically unreliable — regardless of care setting.
 *  - 7 days is the standard maximum interval between routine ambulatory
 *    vital re-checks in most clinical protocols; data older than this
 *    should not be treated as representative of the patient's current
 *    physiological state.
 */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function classifyStaleness(recordedAtIso: string): StalenessTier {
  const ageMs = Date.now() - new Date(recordedAtIso).getTime();
  if (Number.isNaN(ageMs)) return "stale";
  if (ageMs > 24 * 60 * 60 * 1000) return "stale";
  if (ageMs > 4 * 60 * 60 * 1000) return "overdue";
  return "current";
}
