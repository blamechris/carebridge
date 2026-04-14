import { describe, it, expect } from "vitest";
import {
  parseTime,
  getQuietHoursDelay,
  evaluateDelivery,
  type UserPreference,
} from "../workers/preference-rules.js";

/**
 * Tests for notification preference enforcement logic.
 *
 * Verifies that:
 * - Disabled channels suppress non-critical notifications
 * - Quiet hours delay non-critical notifications
 * - Critical notifications bypass both channel disabling and quiet hours
 * - Users with no preferences receive all notifications (opt-out model)
 */

// ---------- parseTime ----------

describe("parseTime", () => {
  it("parses valid HH:MM strings", () => {
    expect(parseTime("22:00")).toEqual({ hours: 22, minutes: 0 });
    expect(parseTime("07:30")).toEqual({ hours: 7, minutes: 30 });
    expect(parseTime("0:00")).toEqual({ hours: 0, minutes: 0 });
  });

  it("returns null for invalid input", () => {
    expect(parseTime(null)).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("12:60")).toBeNull();
    expect(parseTime("abc")).toBeNull();
  });
});

// ---------- getQuietHoursDelay ----------

describe("getQuietHoursDelay", () => {
  it("returns 0 when no quiet hours are set", () => {
    expect(getQuietHoursDelay(null, null)).toBe(0);
    expect(getQuietHoursDelay("22:00", null)).toBe(0);
    expect(getQuietHoursDelay(null, "07:00")).toBe(0);
  });

  it("returns 0 when current time is outside same-day quiet hours", () => {
    const noon = new Date("2026-04-12T12:00:00");
    expect(getQuietHoursDelay("09:00", "11:00", noon)).toBe(0);
  });

  it("returns delay when inside same-day quiet hours", () => {
    const tenAm = new Date("2026-04-12T10:00:00");
    const delay = getQuietHoursDelay("09:00", "11:00", tenAm);
    // 60 minutes until 11:00
    expect(delay).toBe(60 * 60 * 1000);
  });

  it("handles overnight quiet hours (22:00 - 07:00) — current time before midnight", () => {
    const elevenPm = new Date("2026-04-12T23:00:00");
    const delay = getQuietHoursDelay("22:00", "07:00", elevenPm);
    // 8 hours until 07:00
    expect(delay).toBe(8 * 60 * 60 * 1000);
  });

  it("handles overnight quiet hours (22:00 - 07:00) — current time after midnight", () => {
    const twoAm = new Date("2026-04-13T02:00:00");
    const delay = getQuietHoursDelay("22:00", "07:00", twoAm);
    // 5 hours until 07:00
    expect(delay).toBe(5 * 60 * 60 * 1000);
  });

  it("returns 0 when outside overnight quiet hours", () => {
    const noon = new Date("2026-04-12T12:00:00");
    expect(getQuietHoursDelay("22:00", "07:00", noon)).toBe(0);
  });
});

// ---------- evaluateDelivery ----------

describe("evaluateDelivery", () => {
  const now = new Date("2026-04-12T12:00:00");

  it("delivers when user has no preferences (opt-out model)", () => {
    const result = evaluateDelivery([], "ai-flag", "warning", now);
    expect(result.deliver_in_app).toBe(true);
    expect(result.delay_ms).toBe(0);
  });

  it("delivers when user has preferences for a different notification type", () => {
    const prefs: UserPreference[] = [
      {
        notification_type: "message",
        channel: "in_app",
        enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "warning", now);
    expect(result.deliver_in_app).toBe(true);
  });

  it("skips delivery when channel is disabled for non-critical notification", () => {
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "warning", now);
    expect(result.deliver_in_app).toBe(false);
  });

  it("skips delivery for info severity when channel disabled", () => {
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "info", now);
    expect(result.deliver_in_app).toBe(false);
  });

  it("delivers critical notifications even when channel is disabled", () => {
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "critical", now);
    expect(result.deliver_in_app).toBe(true);
    expect(result.delay_ms).toBe(0);
  });

  it("delays non-critical notifications during quiet hours", () => {
    // Quiet hours: 22:00 - 07:00, current time: 23:00
    const lateNight = new Date("2026-04-12T23:00:00");
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: true,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "warning", lateNight);
    expect(result.deliver_in_app).toBe(true);
    expect(result.delay_ms).toBe(8 * 60 * 60 * 1000); // 8 hours
  });

  it("delivers critical notifications immediately during quiet hours", () => {
    const lateNight = new Date("2026-04-12T23:00:00");
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: true,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "critical", lateNight);
    expect(result.deliver_in_app).toBe(true);
    expect(result.delay_ms).toBe(0);
  });

  it("delivers immediately when outside quiet hours", () => {
    const prefs: UserPreference[] = [
      {
        notification_type: "ai-flag",
        channel: "in_app",
        enabled: true,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
      },
    ];
    const result = evaluateDelivery(prefs, "ai-flag", "warning", now); // noon
    expect(result.deliver_in_app).toBe(true);
    expect(result.delay_ms).toBe(0);
  });
});
