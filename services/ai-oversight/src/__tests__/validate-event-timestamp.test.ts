import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { validateEventTimestamp } from "../utils/validate-event-timestamp.js";

// Fixed reference time so tests are deterministic across timezones and CI
// clock drift. 2026-04-16T12:00:00Z aligns with the event timestamp used in
// the context-builder tests in this service.
const NOW_MS = Date.UTC(2026, 3, 16, 12, 0, 0);
const now = () => NOW_MS;

describe("validateEventTimestamp", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns a valid ISO-8601 timestamp unchanged and logs nothing", () => {
    const ts = "2026-04-16T11:59:00.000Z";
    const result = validateEventTimestamp(ts, { now });
    expect(result).toBe(ts);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to now when timestamp is undefined, and warns", () => {
    const result = validateEventTimestamp(undefined, { now, eventId: "evt-1" });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("missing");
    expect(warnSpy.mock.calls[0][0]).toContain("evt-1");
  });

  it("falls back to now when timestamp is an empty string, and warns", () => {
    const result = validateEventTimestamp("", { now, eventId: "evt-2" });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("empty");
    expect(warnSpy.mock.calls[0][0]).toContain("evt-2");
  });

  it("falls back to now when timestamp is whitespace-only", () => {
    const result = validateEventTimestamp("   ", { now });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("empty");
  });

  it("falls back to now when timestamp is unparseable, and warns", () => {
    const result = validateEventTimestamp("not-a-date", {
      now,
      eventId: "evt-3",
    });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("unparseable");
    expect(warnSpy.mock.calls[0][0]).toContain("evt-3");
  });

  it("falls back to now when timestamp is more than 1 minute in the future", () => {
    // 5 minutes past `now` — outside the 1-minute clock-skew grace window.
    const future = new Date(NOW_MS + 5 * 60 * 1000).toISOString();
    const result = validateEventTimestamp(future, { now, eventId: "evt-4" });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("future");
  });

  it("accepts a timestamp within the 1-minute clock-skew grace window", () => {
    // 30 seconds past `now` — inside the grace window.
    const slightlyFuture = new Date(NOW_MS + 30 * 1000).toISOString();
    const result = validateEventTimestamp(slightlyFuture, { now });
    expect(result).toBe(slightlyFuture);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to now when timestamp is before year 2000 (epoch-leak guard)", () => {
    const epoch = "1970-01-01T00:00:00.000Z";
    const result = validateEventTimestamp(epoch, { now, eventId: "evt-5" });
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("too-old");
  });

  it("falls back when a non-string value leaks through the type boundary", () => {
    // Simulates a queue payload that somehow deserialized a number instead of
    // an ISO string. The type system would stop this, but events come off
    // BullMQ as plain JSON — defensive check.
    const result = validateEventTimestamp(
      123 as unknown as string,
      { now, eventId: "evt-6" },
    );
    expect(result).toBe(new Date(NOW_MS).toISOString());
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("not-a-string");
  });

  it("uses the caller label in the log prefix", () => {
    validateEventTimestamp("", {
      now,
      eventId: "evt-7",
      caller: "context-builder",
    });
    expect(warnSpy.mock.calls[0][0]).toContain("[context-builder]");
  });
});
