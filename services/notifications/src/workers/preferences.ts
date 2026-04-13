/**
 * Notification preference enforcement — database layer.
 *
 * Re-exports pure evaluation logic from preference-rules.ts and adds
 * the database query for fetching user preferences.
 */

import { getDb } from "@carebridge/db-schema";
import { notificationPreferences } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import type { UserPreference } from "./preference-rules.js";

export type { UserPreference, DeliveryDecision } from "./preference-rules.js";
export { parseTime, getQuietHoursDelay, evaluateDelivery } from "./preference-rules.js";

/**
 * Fetch all notification preferences for a user.
 */
export async function getUserPreferences(
  userId: string,
): Promise<UserPreference[]> {
  const db = getDb();
  return db
    .select({
      notification_type: notificationPreferences.notification_type,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
      quiet_hours_start: notificationPreferences.quiet_hours_start,
      quiet_hours_end: notificationPreferences.quiet_hours_end,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.user_id, userId));
}
