/**
 * Pure helpers for formatting vital-sign ages and classifying staleness tiers.
 *
 * Extracted from `app/patients/[id]/page.tsx` so they can be unit-tested
 * and reused (e.g. the StaleDataBanner in #256/#496).
 */

import { getStalenessThreshold } from "@carebridge/medical-logic";

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
 * Thresholds are looked up per vital type from `@carebridge/medical-logic`.
 * When no vital type is provided the default acute-care inpatient
 * thresholds (4h / 24h) are used.
 *
 *  - "current":  <= overdueMs — no visual treatment
 *  - "overdue":  overdueMs < age <= staleMs — amber tint, "recheck due"
 *  - "stale":    > staleMs — gray, "stale" label, reader should not trust
 */
export type StalenessTier = "current" | "overdue" | "stale";

export function classifyStaleness(
  recordedAtIso: string,
  vitalType?: string,
): StalenessTier {
  const ageMs = Date.now() - new Date(recordedAtIso).getTime();
  if (Number.isNaN(ageMs)) return "stale";
  const { overdueMs, staleMs } = getStalenessThreshold(vitalType);
  if (ageMs > staleMs) return "stale";
  if (ageMs > overdueMs) return "overdue";
  return "current";
}
