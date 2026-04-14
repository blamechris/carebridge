import { describe, it, expect } from "vitest";
import {
  calculateDelta,
  classifyTrend,
  detectAKI,
  getGoodDirection,
  getTrendColor,
  getTrendInfo,
  isOutOfRange,
  getRangeFlag,
  formatDelta,
  TREND_COLORS,
} from "../trend-utils.js";

// ─── calculateDelta ─────────────────────────────────────────────

describe("calculateDelta", () => {
  it("returns null for fewer than 2 values", () => {
    expect(calculateDelta([])).toBeNull();
    expect(calculateDelta([5])).toBeNull();
  });

  it("calculates delta between last two values", () => {
    const delta = calculateDelta([10, 15]);
    expect(delta).not.toBeNull();
    expect(delta!.current).toBe(15);
    expect(delta!.previous).toBe(10);
    expect(delta!.change).toBe(5);
    expect(delta!.pctChange).toBe(50);
  });

  it("uses only last two values from longer array", () => {
    const delta = calculateDelta([1, 2, 3, 100, 200]);
    expect(delta!.current).toBe(200);
    expect(delta!.previous).toBe(100);
  });

  it("handles zero previous value without division error", () => {
    const delta = calculateDelta([0, 10]);
    expect(delta!.pctChange).toBe(0);
  });
});

// ─── getGoodDirection ───────────────────────────────────────────

describe("getGoodDirection", () => {
  it("returns 'up' for WBC (recovery metric)", () => {
    expect(getGoodDirection("WBC", "lab")).toBe("up");
  });

  it("returns 'down' for tumor markers like CA-125", () => {
    expect(getGoodDirection("CA-125", "lab")).toBe("down");
  });

  it("returns 'stable' for unknown lab test", () => {
    expect(getGoodDirection("SomeUnknownLab", "lab")).toBe("stable");
  });

  it("returns 'down' for pain_level vital", () => {
    expect(getGoodDirection("pain_level", "vital")).toBe("down");
  });

  it("returns 'up' for o2_sat vital", () => {
    expect(getGoodDirection("o2_sat", "vital")).toBe("up");
  });
});

// ─── getTrendColor ──────────────────────────────────────────────

describe("getTrendColor", () => {
  it("returns 'warning' when out of range", () => {
    expect(getTrendColor(5, "up", true)).toBe("warning");
  });

  it("returns 'neutral' for negligible change", () => {
    expect(getTrendColor(0.001, "up")).toBe("neutral");
  });

  it("returns 'positive' when up is good and change is up", () => {
    expect(getTrendColor(5, "up")).toBe("positive");
  });

  it("returns 'negative' when up is good but change is down", () => {
    expect(getTrendColor(-5, "up")).toBe("negative");
  });

  it("returns 'positive' when down is good and change is down", () => {
    expect(getTrendColor(-5, "down")).toBe("positive");
  });

  it("returns 'negative' when down is good but change is up", () => {
    expect(getTrendColor(5, "down")).toBe("negative");
  });

  it("returns 'neutral' for stable direction regardless of change", () => {
    expect(getTrendColor(10, "stable")).toBe("neutral");
  });
});

// ─── getTrendInfo ───────────────────────────────────────────────

describe("getTrendInfo", () => {
  it("returns neutral arrow for single value", () => {
    const info = getTrendInfo([42], "up");
    expect(info.delta).toBeNull();
    expect(info.arrow).toBe("→");
    expect(info.color).toBe("neutral");
  });

  it("returns up arrow for increasing values", () => {
    const info = getTrendInfo([10, 20], "up");
    expect(info.arrow).toBe("↑");
    expect(info.color).toBe("positive");
  });

  it("returns down arrow for decreasing values", () => {
    const info = getTrendInfo([20, 10], "down");
    expect(info.arrow).toBe("↓");
    expect(info.color).toBe("positive");
  });

  it("uses correct hex color from TREND_COLORS", () => {
    const info = getTrendInfo([10, 20], "up");
    expect(info.hex).toBe(TREND_COLORS.positive);
  });
});

// ─── isOutOfRange ───────────────────────────────────────────────

describe("isOutOfRange", () => {
  it("returns false when value is within range", () => {
    expect(isOutOfRange(5, 0, 10)).toBe(false);
  });

  it("returns true when value is below low", () => {
    expect(isOutOfRange(-1, 0, 10)).toBe(true);
  });

  it("returns true when value is above high", () => {
    expect(isOutOfRange(11, 0, 10)).toBe(true);
  });

  it("returns false when no reference bounds", () => {
    expect(isOutOfRange(5)).toBe(false);
  });
});

// ─── getRangeFlag ───────────────────────────────────────────────

describe("getRangeFlag", () => {
  it("returns null when value is in range", () => {
    expect(getRangeFlag(5, 0, 10)).toBeNull();
  });

  it("returns 'H' for high value", () => {
    expect(getRangeFlag(12, 0, 10)).toBe("H");
  });

  it("returns 'L' for low value", () => {
    expect(getRangeFlag(-1, 0, 10)).toBe("L");
  });

  it("returns 'critical' for extremely out-of-range value", () => {
    // range is 0-10, so range=10. critical when > 10+10=20 or < 0-10=-10
    expect(getRangeFlag(25, 0, 10)).toBe("critical");
    expect(getRangeFlag(-15, 0, 10)).toBe("critical");
  });

  it("returns null when reference bounds are undefined", () => {
    expect(getRangeFlag(5, undefined, undefined)).toBeNull();
  });
});

// ─── formatDelta ────────────────────────────────────────────────

describe("formatDelta", () => {
  it("returns first reading message for null delta", () => {
    expect(formatDelta(null, "mg/dL")).toContain("first reading");
  });

  it("returns stable for negligible change", () => {
    const delta = { current: 10, previous: 10, change: 0.001, pctChange: 0.01 };
    expect(formatDelta(delta, "mg/dL")).toContain("stable");
  });

  it("formats positive change with plus sign", () => {
    const delta = { current: 15, previous: 10, change: 5, pctChange: 50 };
    const formatted = formatDelta(delta, "mg/dL");
    expect(formatted).toContain("+");
    expect(formatted).toContain("mg/dL");
  });
});

// ─── Creatinine / BUN trend direction (issue #213) ──────────────────────

describe("Creatinine and BUN trend classification", () => {
  it("treats Creatinine as 'down is good' so rising values flag as negative", () => {
    expect(getGoodDirection("Creatinine", "lab")).toBe("down");
  });

  it("treats BUN as 'down is good' so rising values flag as negative", () => {
    expect(getGoodDirection("BUN", "lab")).toBe("down");
  });

  it("classifies rising creatinine 0.7 → 1.0 → 1.4 as negative trend, not neutral", () => {
    // Realistic AKI trajectory. Previously this returned neutral because the
    // good-direction was 'stable', which hid the rising kidney-function
    // signal from the oversight layer.
    const info = getTrendInfo([0.7, 1.0, 1.4], getGoodDirection("Creatinine"));
    expect(info.arrow).toBe("↑");
    expect(info.color).toBe("negative");
  });

  it("classifies rising BUN 15 → 22 → 35 as negative trend", () => {
    const info = getTrendInfo([15, 22, 35], getGoodDirection("BUN"));
    expect(info.arrow).toBe("↑");
    expect(info.color).toBe("negative");
  });

  it("classifies falling creatinine (resolving AKI) as positive trend", () => {
    const info = getTrendInfo([2.1, 1.6, 1.1], getGoodDirection("Creatinine"));
    expect(info.arrow).toBe("↓");
    expect(info.color).toBe("positive");
  });
});

// ─── classifyTrend ──────────────────────────────────────────────────────

describe("classifyTrend", () => {
  it("returns 'stable' for fewer than 2 values", () => {
    expect(classifyTrend([])).toBe("stable");
    expect(classifyTrend([1.0])).toBe("stable");
  });

  it("labels a clean rise as 'rising'", () => {
    expect(classifyTrend([0.7, 1.0, 1.4])).toBe("rising");
  });

  it("labels a clean fall as 'falling'", () => {
    expect(classifyTrend([2.1, 1.6, 1.1])).toBe("falling");
  });

  it("labels a flat series as 'stable'", () => {
    expect(classifyTrend([1.0, 1.0, 1.0])).toBe("stable");
  });

  it("labels a noisy but net-rising series as 'rising'", () => {
    // Realistic noisy lab trajectory — endpoint-to-endpoint is still up.
    expect(classifyTrend([0.7, 0.9, 0.8, 1.1, 1.4])).toBe("rising");
  });

  it("honors the tolerance parameter for stability", () => {
    // 0.05 change is below a 0.1 tolerance → stable.
    expect(classifyTrend([1.0, 1.05], 0.1)).toBe("stable");
    // 0.05 change is above the default 0.01 tolerance → rising.
    expect(classifyTrend([1.0, 1.05])).toBe("rising");
  });
});

// ─── detectAKI (KDIGO criteria) ─────────────────────────────────────────

describe("detectAKI", () => {
  const hoursAgo = (h: number) =>
    new Date(Date.parse("2026-04-12T12:00:00Z") - h * 60 * 60 * 1000).toISOString();

  it("returns no AKI for a single reading", () => {
    const r = detectAKI([{ value: 1.0, timestamp: hoursAgo(0) }]);
    expect(r.isAKI).toBe(false);
    expect(r.stage).toBeNull();
  });

  it("returns no AKI for stable creatinine", () => {
    const r = detectAKI([
      { value: 1.0, timestamp: hoursAgo(72) },
      { value: 1.0, timestamp: hoursAgo(24) },
      { value: 1.0, timestamp: hoursAgo(0) },
    ]);
    expect(r.isAKI).toBe(false);
  });

  it("detects AKI by absolute rise ≥ 0.3 mg/dL within 48h (0.7 → 1.0 → 1.4)", () => {
    const r = detectAKI([
      { value: 0.7, timestamp: hoursAgo(40) },
      { value: 1.0, timestamp: hoursAgo(24) },
      { value: 1.4, timestamp: hoursAgo(0) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.criterion).toBe("absolute-rise-48h");
    expect(r.baseline).toBe(0.7);
    expect(r.peak).toBe(1.4);
    // 1.4 / 0.7 = 2.0x → KDIGO stage 2.
    expect(r.stage).toBe(2);
  });

  it("correctly stages a 2.0x rise as stage 2", () => {
    const r = detectAKI([
      { value: 0.8, timestamp: hoursAgo(40) },
      { value: 1.6, timestamp: hoursAgo(0) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.stage).toBe(2);
  });

  it("correctly stages a ≥ 3.0x rise as stage 3", () => {
    const r = detectAKI([
      { value: 0.8, timestamp: hoursAgo(40) },
      { value: 2.5, timestamp: hoursAgo(0) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.stage).toBe(3);
  });

  it("detects AKI by 1.5x relative rise over 7 days when 48h window is clean", () => {
    const daysAgo = (d: number) => hoursAgo(d * 24);
    // Only the most recent reading lies within the 48h window, so the
    // absolute-rise criterion has no delta to evaluate. The 7-day baseline
    // (0.9) vs peak (1.4) is a 1.56x rise → KDIGO AKI.
    const r = detectAKI([
      { value: 0.9, timestamp: daysAgo(6) },
      { value: 1.0, timestamp: daysAgo(3) },
      { value: 1.4, timestamp: daysAgo(0) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.criterion).toBe("relative-rise-7d");
    expect(r.baseline).toBe(0.9);
    expect(r.peak).toBe(1.4);
  });

  it("uses the 7-day relative criterion when 48h rise is below 0.3", () => {
    const daysAgo = (d: number) => hoursAgo(d * 24);
    // Last two points are <= 48h apart and differ by 0.1 → no absolute rise.
    // But baseline 6 days ago is 0.6, latest 0.95 → 1.58x → AKI stage 1.
    const r = detectAKI([
      { value: 0.6, timestamp: daysAgo(6) },
      { value: 0.85, timestamp: hoursAgo(36) },
      { value: 0.95, timestamp: hoursAgo(0) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.criterion).toBe("relative-rise-7d");
    expect(r.stage).toBe(1);
  });

  it("sorts readings by timestamp regardless of input order", () => {
    const r = detectAKI([
      { value: 1.4, timestamp: hoursAgo(0) },
      { value: 0.7, timestamp: hoursAgo(40) },
      { value: 1.0, timestamp: hoursAgo(24) },
    ]);
    expect(r.isAKI).toBe(true);
    expect(r.peak).toBe(1.4);
  });
});
