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
// classifyStaleness
// ---------------------------------------------------------------------------
describe("classifyStaleness", () => {
  it('returns "current" for timestamps <= 4h ago', () => {
    expect(classifyStaleness(ago(0))).toBe("current");
    expect(classifyStaleness(ago(2 * HOUR))).toBe("current");
    expect(classifyStaleness(ago(4 * HOUR))).toBe("current");
  });

  it('returns "overdue" for timestamps >4h and <=24h ago', () => {
    expect(classifyStaleness(ago(4 * HOUR + 1))).toBe("overdue");
    expect(classifyStaleness(ago(12 * HOUR))).toBe("overdue");
    expect(classifyStaleness(ago(24 * HOUR))).toBe("overdue");
  });

  it('returns "stale" for timestamps >24h ago', () => {
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
    // new Date("not-a-date").getTime() => NaN; Date.now() - NaN => NaN
    // NaN is caught by the Number.isNaN guard and treated as stale
    expect(classifyStaleness("not-a-date")).toBe("stale");
    expect(classifyStaleness("")).toBe("stale");
    expect(classifyStaleness("abc123")).toBe("stale");
  });
});
