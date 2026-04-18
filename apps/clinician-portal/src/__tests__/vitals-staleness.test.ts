import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatAge, classifyStaleness } from "../lib/vitals-staleness.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PINNED_NOW = new Date("2025-06-15T12:00:00.000Z");

/** Helper: ISO string for `ms` milliseconds before the pinned clock. */
function ago(ms: number): string {
  return new Date(PINNED_NOW.getTime() - ms).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// formatAge
// ---------------------------------------------------------------------------
describe("formatAge", () => {
  it('returns "just now" for timestamps < 1 minute ago', () => {
    expect(formatAge(ago(0))).toBe("just now");
    expect(formatAge(ago(30 * SECOND))).toBe("just now");
    expect(formatAge(ago(59 * SECOND))).toBe("just now");
  });

  it("returns minutes for timestamps 1m–59m ago", () => {
    expect(formatAge(ago(1 * MINUTE))).toBe("1m ago");
    expect(formatAge(ago(30 * MINUTE))).toBe("30m ago");
    expect(formatAge(ago(59 * MINUTE))).toBe("59m ago");
  });

  it("returns hours for timestamps 1h–47h ago", () => {
    expect(formatAge(ago(1 * HOUR))).toBe("1h ago");
    expect(formatAge(ago(6 * HOUR))).toBe("6h ago");
    expect(formatAge(ago(23 * HOUR))).toBe("23h ago");
    expect(formatAge(ago(47 * HOUR))).toBe("47h ago");
  });

  it("returns days for timestamps >= 48h ago", () => {
    expect(formatAge(ago(48 * HOUR))).toBe("2d ago");
    expect(formatAge(ago(7 * DAY))).toBe("7d ago");
    expect(formatAge(ago(30 * DAY))).toBe("30d ago");
  });

  it("boundary: exactly 60s transitions from 'just now' to minutes", () => {
    // 60_000 ms rounds to 1 minute
    expect(formatAge(ago(60 * SECOND))).toBe("1m ago");
  });

  it("boundary: exactly 60 minutes transitions to hours", () => {
    expect(formatAge(ago(60 * MINUTE))).toBe("1h ago");
  });

  it("boundary: exactly 48 hours transitions to days", () => {
    expect(formatAge(ago(48 * HOUR))).toBe("2d ago");
  });

  it('returns "unknown" for invalid ISO strings', () => {
    expect(formatAge("not-a-date")).toBe("unknown");
    expect(formatAge("")).toBe("unknown");
    expect(formatAge("abc123")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// classifyStaleness — default thresholds (no vital type / unknown type)
// ---------------------------------------------------------------------------
describe("classifyStaleness", () => {
  it('returns "current" for timestamps <= 4h ago (default)', () => {
    expect(classifyStaleness(ago(0))).toBe("current");
    expect(classifyStaleness(ago(2 * HOUR))).toBe("current");
    expect(classifyStaleness(ago(4 * HOUR))).toBe("current");
  });

  it('returns "overdue" for timestamps >4h and <=24h ago (default)', () => {
    expect(classifyStaleness(ago(4 * HOUR + 1))).toBe("overdue");
    expect(classifyStaleness(ago(12 * HOUR))).toBe("overdue");
    expect(classifyStaleness(ago(24 * HOUR))).toBe("overdue");
  });

  it('returns "stale" for timestamps >24h ago (default)', () => {
    expect(classifyStaleness(ago(24 * HOUR + 1))).toBe("stale");
    expect(classifyStaleness(ago(7 * DAY))).toBe("stale");
  });

  it("boundary: exactly 4h is current (<=)", () => {
    expect(classifyStaleness(ago(4 * HOUR))).toBe("current");
  });

  it("boundary: exactly 24h is overdue (<=)", () => {
    expect(classifyStaleness(ago(24 * HOUR))).toBe("overdue");
  });

  it("boundary: 1ms past 24h is stale", () => {
    expect(classifyStaleness(ago(24 * HOUR + 1))).toBe("stale");
  });

  it('future-dated timestamp (clock skew) returns "current"', () => {
    const future = new Date(PINNED_NOW.getTime() + 5 * MINUTE).toISOString();
    expect(classifyStaleness(future)).toBe("current");
  });

  it('returns "stale" for invalid ISO strings (NaN guard)', () => {
    expect(classifyStaleness("not-a-date")).toBe("stale");
    expect(classifyStaleness("")).toBe("stale");
    expect(classifyStaleness("abc123")).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// classifyStaleness — per-vital-type thresholds
// ---------------------------------------------------------------------------
describe("classifyStaleness per-vital-type", () => {
  // --- Acute-care vitals (4h / 24h) — same as default ---
  describe.each([
    "blood_pressure",
    "heart_rate",
    "temperature",
    "o2_sat",
    "respiratory_rate",
  ] as const)("%s (4h/24h)", (vitalType) => {
    it("current at 4h", () => {
      expect(classifyStaleness(ago(4 * HOUR), vitalType)).toBe("current");
    });
    it("overdue at 4h+1ms", () => {
      expect(classifyStaleness(ago(4 * HOUR + 1), vitalType)).toBe("overdue");
    });
    it("overdue at 24h", () => {
      expect(classifyStaleness(ago(24 * HOUR), vitalType)).toBe("overdue");
    });
    it("stale at 24h+1ms", () => {
      expect(classifyStaleness(ago(24 * HOUR + 1), vitalType)).toBe("stale");
    });
  });

  // --- Weight (24h / 7d) ---
  describe("weight (24h/168h)", () => {
    it("current at 12h", () => {
      expect(classifyStaleness(ago(12 * HOUR), "weight")).toBe("current");
    });

    it("current at exactly 24h", () => {
      expect(classifyStaleness(ago(24 * HOUR), "weight")).toBe("current");
    });

    it("overdue at 24h+1ms", () => {
      expect(classifyStaleness(ago(24 * HOUR + 1), "weight")).toBe("overdue");
    });

    it("overdue at 3 days", () => {
      expect(classifyStaleness(ago(3 * DAY), "weight")).toBe("overdue");
    });

    it("overdue at exactly 7 days", () => {
      expect(classifyStaleness(ago(7 * DAY), "weight")).toBe("overdue");
    });

    it("stale at 7 days + 1ms", () => {
      expect(classifyStaleness(ago(7 * DAY + 1), "weight")).toBe("stale");
    });

    it("stale at 14 days", () => {
      expect(classifyStaleness(ago(14 * DAY), "weight")).toBe("stale");
    });
  });

  // --- Unknown vital type falls back to default ---
  describe("unknown vital type", () => {
    it("uses default 4h/24h thresholds", () => {
      expect(classifyStaleness(ago(4 * HOUR), "unknown_type")).toBe("current");
      expect(classifyStaleness(ago(4 * HOUR + 1), "unknown_type")).toBe(
        "overdue",
      );
      expect(classifyStaleness(ago(24 * HOUR + 1), "unknown_type")).toBe(
        "stale",
      );
    });
  });
});
