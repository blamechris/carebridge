/**
 * Per-vital-type staleness thresholds.
 *
 * Each vital sign has its own clinically-appropriate thresholds for
 * transitioning between "current", "overdue", and "stale" tiers.
 *
 * The default thresholds (4h / 24h) match acute-care inpatient monitoring.
 * Vitals like weight that are typically measured less frequently use
 * wider windows to avoid false "stale" classifications in outpatient
 * and chronic-care contexts.
 */

import type { VitalType } from "@carebridge/shared-types";

export interface StalenessThreshold {
  /** Age in ms beyond which a reading is "overdue" (needs re-check). */
  readonly overdueMs: number;
  /** Age in ms beyond which a reading is "stale" (do not trust). */
  readonly staleMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Default thresholds used for vital types without a specific entry,
 * matching acute-care inpatient expectations (4h / 24h).
 */
export const DEFAULT_STALENESS_THRESHOLD: StalenessThreshold = {
  overdueMs: 4 * HOUR,
  staleMs: 24 * HOUR,
};

/**
 * Per-vital-type staleness thresholds.
 *
 * Only vitals that differ from the default need an explicit entry.
 * Types not listed here fall through to `DEFAULT_STALENESS_THRESHOLD`.
 */
export const VITAL_STALENESS_THRESHOLDS: Partial<
  Record<VitalType, StalenessThreshold>
> = {
  blood_pressure: { overdueMs: 4 * HOUR, staleMs: 24 * HOUR },
  heart_rate: { overdueMs: 4 * HOUR, staleMs: 24 * HOUR },
  temperature: { overdueMs: 4 * HOUR, staleMs: 24 * HOUR },
  weight: { overdueMs: 24 * HOUR, staleMs: 7 * DAY },
  o2_sat: { overdueMs: 4 * HOUR, staleMs: 24 * HOUR },
  respiratory_rate: { overdueMs: 4 * HOUR, staleMs: 24 * HOUR },
  // Anthropometric vitals (#1176). Acute-care 4h/24h is wrong: these
  // refresh on a monthly (pediatric well-child) or annual (adult)
  // cadence, mirroring the `weight` precedent above. Without explicit
  // entries a 5h-old body_height would flag overdue — clinical noise.
  body_height: { overdueMs: 30 * DAY, staleMs: 365 * DAY },
  bmi: { overdueMs: 30 * DAY, staleMs: 365 * DAY },
  head_circumference: { overdueMs: 30 * DAY, staleMs: 6 * 30 * DAY },
};

/**
 * Look up the staleness threshold for a given vital type.
 * Falls back to the default acute-care thresholds for unknown types.
 */
export function getStalenessThreshold(
  vitalType?: VitalType | string,
): StalenessThreshold {
  if (!vitalType) return DEFAULT_STALENESS_THRESHOLD;
  return (
    VITAL_STALENESS_THRESHOLDS[vitalType as VitalType] ??
    DEFAULT_STALENESS_THRESHOLD
  );
}
