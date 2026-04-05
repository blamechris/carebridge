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
  Creatinine: "stable",
  BUN: "stable",
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
