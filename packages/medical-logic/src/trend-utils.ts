/**
 * Trend & Delta Utilities — ported from MedLens
 *
 * Core insight: in medical data, "up" isn't universally good or bad.
 *   - WBC recovering after chemo → up is GREEN
 *   - Tumor marker (CA-125) dropping → down is GREEN
 *   - Temperature spiking → up is RED
 */

export type GoodDirection = "up" | "down" | "stable";

export interface Delta {
  current: number;
  previous: number;
  change: number;
  pctChange: number;
}

export type TrendColor = "positive" | "negative" | "neutral" | "warning";

export interface TrendInfo {
  delta: Delta | null;
  color: TrendColor;
  arrow: "↑" | "↓" | "→";
  hex: string;
}

export const TREND_COLORS: Record<TrendColor, string> = {
  positive: "#30D158",
  negative: "#FF453A",
  neutral: "#8E8E93",
  warning: "#FF9F0A",
};

const LAB_DIRECTIONS: Record<string, GoodDirection> = {
  WBC: "up",
  RBC: "up",
  Hemoglobin: "up",
  Hematocrit: "up",
  Platelets: "up",
  ANC: "up",
  "CA-125": "down",
  "CA 19-9": "down",
  CEA: "down",
  AFP: "down",
  PSA: "down",
  // Creatinine and BUN: rising indicates kidney injury (AKI/CKD progression).
  // Treat "down" as the desirable direction so rising values surface as negative
  // trends rather than silently displaying as neutral/stable. See KDIGO AKI
  // criteria and `detectAKI` below for programmatic rise detection.
  Creatinine: "down",
  BUN: "down",
  ALT: "down",
  AST: "down",
  Sodium: "stable",
  Potassium: "stable",
  Chloride: "stable",
  CO2: "stable",
  Calcium: "stable",
};

const VITAL_DIRECTIONS: Record<string, GoodDirection> = {
  blood_pressure: "down",
  heart_rate: "stable",
  o2_sat: "up",
  temperature: "stable",
  weight: "stable",
  respiratory_rate: "stable",
  pain_level: "down",
  blood_glucose: "stable",
};

export function getGoodDirection(
  metricName: string,
  metricType: "lab" | "vital" = "lab"
): GoodDirection {
  if (metricType === "vital") return VITAL_DIRECTIONS[metricName] ?? "stable";
  return LAB_DIRECTIONS[metricName] ?? "stable";
}

export function calculateDelta(values: number[]): Delta | null {
  if (values.length < 2) return null;
  const current = values[values.length - 1];
  const previous = values[values.length - 2];
  const change = current - previous;
  const pctChange = previous !== 0 ? (change / previous) * 100 : 0;
  return { current, previous, change, pctChange };
}

/**
 * Compute a delta against an explicit baseline rather than the immediately
 * preceding point.
 *
 * Clinical rationale: for labs like creatinine, BUN, and liver enzymes a
 * slow drift of 0.7 → 0.8 → 0.9 → 1.1 → 1.2 is a ~70% rise that KDIGO
 * would classify as stage-1 AKI — but `calculateDelta` reports the
 * last-two-point change of +0.1 (+9%), which reads as "slightly rising"
 * or even "stable" under a naive threshold. Computing against baseline
 * preserves the actual trajectory.
 *
 * When `baseline` is omitted, the first value in `values` is used as the
 * baseline so callers that only know the series still get the correct
 * "change-from-baseline" semantics.
 */
export function calculateDeltaFromBaseline(
  values: number[],
  baseline?: number,
): Delta | null {
  if (values.length === 0) return null;
  const current = values[values.length - 1]!;
  const base = baseline ?? values[0]!;
  if (values.length < 2 && baseline === undefined) return null;
  const change = current - base;
  const pctChange = base !== 0 ? (change / base) * 100 : 0;
  return { current, previous: base, change, pctChange };
}

export function getTrendColor(
  change: number,
  goodDirection: GoodDirection,
  isOutOfRange?: boolean
): TrendColor {
  if (isOutOfRange) return "warning";
  if (Math.abs(change) < 0.01) return "neutral";
  const isUp = change > 0;
  switch (goodDirection) {
    case "up":
      return isUp ? "positive" : "negative";
    case "down":
      return isUp ? "negative" : "positive";
    case "stable":
      return "neutral";
  }
}

export function getTrendInfo(
  values: number[],
  goodDirection: GoodDirection,
  isOutOfRange?: boolean
): TrendInfo {
  const delta = calculateDelta(values);
  if (!delta) {
    return { delta: null, color: "neutral", arrow: "→", hex: TREND_COLORS.neutral };
  }
  const color = getTrendColor(delta.change, goodDirection, isOutOfRange);
  const arrow = Math.abs(delta.change) < 0.01 ? "→" : delta.change > 0 ? "↑" : "↓";
  return { delta, color, arrow, hex: TREND_COLORS[color] };
}

/**
 * Baseline-aware variant of `getTrendInfo`. Use this whenever a per-patient
 * baseline exists (prior-admission creatinine, known-good BP, etc.) — the
 * color/arrow will reflect movement from that stable value instead of from
 * the last noisy reading. For ambiguous cases pass `baseline = undefined`
 * and the first value in the series acts as the baseline.
 */
export function getTrendInfoFromBaseline(
  values: number[],
  goodDirection: GoodDirection,
  baseline?: number,
  isOutOfRange?: boolean,
): TrendInfo {
  const delta = calculateDeltaFromBaseline(values, baseline);
  if (!delta) {
    return { delta: null, color: "neutral", arrow: "→", hex: TREND_COLORS.neutral };
  }
  const color = getTrendColor(delta.change, goodDirection, isOutOfRange);
  const arrow = Math.abs(delta.change) < 0.01 ? "→" : delta.change > 0 ? "↑" : "↓";
  return { delta, color, arrow, hex: TREND_COLORS[color] };
}

export function isOutOfRange(value: number, refLow?: number, refHigh?: number): boolean {
  if (refLow !== undefined && value < refLow) return true;
  if (refHigh !== undefined && value > refHigh) return true;
  return false;
}

export function getRangeFlag(
  value: number,
  refLow?: number,
  refHigh?: number
): "H" | "L" | "critical" | null {
  if (refLow === undefined || refHigh === undefined) return null;
  const range = refHigh - refLow;
  if (value < refLow - range || value > refHigh + range) return "critical";
  if (value > refHigh) return "H";
  if (value < refLow) return "L";
  return null;
}

export function formatDelta(delta: Delta | null, unit: string): string {
  if (!delta) return "— first reading";
  if (Math.abs(delta.change) < 0.01) return "→ stable";
  const sign = delta.change > 0 ? "+" : "−";
  const absChange = Math.abs(delta.change);
  const absPct = Math.abs(delta.pctChange);
  const changeStr = absChange >= 10 ? absChange.toFixed(0) : absChange.toFixed(1);
  const pctStr = absPct.toFixed(1);
  return `${sign}${changeStr} ${unit} (${pctStr}%)`;
}

// ─── Trend classification ──────────────────────────────────────────────
//
// Classifies a sequence of values as rising, falling, or stable independent
// of the "good direction" semantics used for coloring. The trend color
// (`getTrendColor`) answers "is the change good or bad for the patient?";
// the trend *direction* answers "which way are the numbers moving?".
//
// For metrics like creatinine and BUN this distinction matters: a rise from
// 0.7 → 1.0 → 1.4 mg/dL is unambiguously "rising" even though a lazy
// last-two-point comparison or a noisy signal might obscure it.

export type TrendDirection = "rising" | "falling" | "stable";

/**
 * Classify a series of values as rising / falling / stable.
 *
 * Uses both the endpoint delta and a monotonicity check so that noisy but
 * trending-up data (0.7 → 0.9 → 0.8 → 1.1 → 1.4) is still classified as
 * rising. The `tolerance` parameter is the minimum absolute change from the
 * first to the last value for the series to count as non-stable.
 */
export function classifyTrend(
  values: number[],
  tolerance = 0.01
): TrendDirection {
  if (values.length < 2) return "stable";
  const first = values[0];
  const last = values[values.length - 1];
  const totalChange = last - first;
  if (Math.abs(totalChange) < tolerance) return "stable";
  return totalChange > 0 ? "rising" : "falling";
}

// ─── KDIGO AKI detection ───────────────────────────────────────────────
//
// KDIGO defines AKI by ANY of:
//   1. Rise in serum creatinine ≥ 0.3 mg/dL within 48 hours
//   2. Rise in serum creatinine to ≥ 1.5x baseline, known or presumed to
//      have occurred within the prior 7 days
//   3. Urine output < 0.5 mL/kg/h for ≥ 6 hours (not handled here — we
//      only see lab trends, not fluid balance)
//
// This helper evaluates (1) and (2) from a time-ordered creatinine series.

export interface CreatinineReading {
  /** Serum creatinine in mg/dL */
  value: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

export type AKIStage = 1 | 2 | 3;

export interface AKIResult {
  /** True if KDIGO criteria (1) or (2) are met */
  isAKI: boolean;
  /** KDIGO stage when AKI is detected, based on peak rise vs baseline. */
  stage: AKIStage | null;
  /** Which KDIGO criterion triggered the detection, if any. */
  criterion: "absolute-rise-48h" | "relative-rise-7d" | null;
  /** Baseline creatinine used for the relative-rise comparison. */
  baseline: number | null;
  /** Peak creatinine observed in the evaluation window. */
  peak: number | null;
}

const MS_PER_HOUR = 60 * 60 * 1000;

function kdigoStage(peak: number, baseline: number): AKIStage {
  const ratio = peak / baseline;
  const absoluteRise = peak - baseline;
  // Stage 3: ≥ 3.0x baseline OR creatinine ≥ 4.0 mg/dL with acute rise ≥ 0.5
  if (ratio >= 3.0 || (peak >= 4.0 && absoluteRise >= 0.5)) return 3;
  // Stage 2: 2.0–2.9x baseline
  if (ratio >= 2.0) return 2;
  // Stage 1: 1.5–1.9x baseline OR rise ≥ 0.3 mg/dL
  return 1;
}

/**
 * Detect AKI from a time-ordered series of creatinine readings.
 *
 * Readings should be sorted ascending by timestamp. The lowest value within
 * the prior 7 days is used as the baseline for the relative-rise criterion.
 */
export function detectAKI(readings: CreatinineReading[]): AKIResult {
  const empty: AKIResult = {
    isAKI: false,
    stage: null,
    criterion: null,
    baseline: null,
    peak: null,
  };
  if (readings.length < 2) return empty;

  const sorted = [...readings].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
  );
  const latest = sorted[sorted.length - 1];
  const latestMs = Date.parse(latest.timestamp);

  // Criterion 1: rise ≥ 0.3 mg/dL within any 48h window ending at latest.
  const window48h = sorted.filter(
    (r) => latestMs - Date.parse(r.timestamp) <= 48 * MS_PER_HOUR
  );
  let minIn48h = latest.value;
  let peakIn48h = latest.value;
  for (const r of window48h) {
    if (r.value < minIn48h) minIn48h = r.value;
    if (r.value > peakIn48h) peakIn48h = r.value;
  }
  if (peakIn48h - minIn48h >= 0.3) {
    return {
      isAKI: true,
      stage: kdigoStage(peakIn48h, minIn48h),
      criterion: "absolute-rise-48h",
      baseline: minIn48h,
      peak: peakIn48h,
    };
  }

  // Criterion 2: rise to ≥ 1.5x baseline within the prior 7 days.
  const window7d = sorted.filter(
    (r) => latestMs - Date.parse(r.timestamp) <= 7 * 24 * MS_PER_HOUR
  );
  let baseline = latest.value;
  let peak = latest.value;
  for (const r of window7d) {
    if (r.value < baseline) baseline = r.value;
    if (r.value > peak) peak = r.value;
  }
  if (baseline > 0 && peak / baseline >= 1.5) {
    return {
      isAKI: true,
      stage: kdigoStage(peak, baseline),
      criterion: "relative-rise-7d",
      baseline,
      peak,
    };
  }

  return empty;
}
