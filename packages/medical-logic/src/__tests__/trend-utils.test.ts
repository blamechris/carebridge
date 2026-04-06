import { describe, it, expect } from "vitest";
import {
  calculateDelta,
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
