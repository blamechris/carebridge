/**
 * Pure preference evaluation logic — no database dependencies.
 *
 * These functions determine delivery decisions based on already-fetched
 * user preferences. Separated from preferences.ts so they can be
 * unit-tested without requiring @carebridge/db-schema to be built.
 */

export interface UserPreference {
  notification_type: string;
  channel: string;
  enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

export interface DeliveryDecision {
  /** Whether the in_app channel should be delivered */
  deliver_in_app: boolean;
  /** Delay in milliseconds before delivery (0 = immediate) */
  delay_ms: number;
}

/**
 * Parse an "HH:MM" time string into { hours, minutes }.
 * Returns null on invalid input.
 */
export function parseTime(value: string | null): { hours: number; minutes: number } | null {
  if (value == null) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * Check whether the current time falls within a quiet hours window.
 *
 * Supports windows that cross midnight (e.g. 22:00 - 07:00).
 * Returns the delay in milliseconds until quiet hours end, or 0 if
 * the current time is outside quiet hours.
 */
export function getQuietHoursDelay(
  quietStart: string | null,
  quietEnd: string | null,
  now: Date = new Date(),
): number {
  const start = parseTime(quietStart);
  const end = parseTime(quietEnd);
  if (start == null || end == null) return 0;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  let inQuietHours = false;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g. 09:00 - 17:00)
    inQuietHours = nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Overnight window (e.g. 22:00 - 07:00)
    inQuietHours = nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  if (!inQuietHours) return 0;

  // Calculate delay until quiet hours end
  let delayMinutes: number;
  if (nowMinutes < endMinutes) {
    delayMinutes = endMinutes - nowMinutes;
  } else {
    // Past midnight wrap: remaining today + minutes into tomorrow
    delayMinutes = (24 * 60 - nowMinutes) + endMinutes;
  }

  return delayMinutes * 60 * 1000;
}

/**
 * Determine the delivery decision for a single notification to a user.
 *
 * @param preferences - The user's stored preferences
 * @param notificationType - The notification type (e.g. "ai-flag")
 * @param severity - The flag severity ("critical", "warning", "info")
 * @param now - Current time (injectable for testing)
 */
export function evaluateDelivery(
  preferences: UserPreference[],
  notificationType: string,
  severity: string,
  now: Date = new Date(),
): DeliveryDecision {
  const isUrgent = severity === "critical";

  // Find preferences matching this notification type for the in_app channel
  const inAppPref = preferences.find(
    (p) => p.notification_type === notificationType && p.channel === "in_app",
  );

  // Default: deliver if no preference exists (opt-out model)
  let deliverInApp = true;
  let delayMs = 0;

  if (inAppPref != null) {
    // Check if channel is disabled
    if (!inAppPref.enabled) {
      // Critical notifications bypass disabled channels
      deliverInApp = isUrgent;
    }

    // Check quiet hours (only for non-critical)
    if (deliverInApp && !isUrgent) {
      delayMs = getQuietHoursDelay(
        inAppPref.quiet_hours_start,
        inAppPref.quiet_hours_end,
        now,
      );
    }
  }

  return { deliver_in_app: deliverInApp, delay_ms: delayMs };
}
