/**
 * User notification preferences schema.
 *
 * Controls how and when notifications are delivered to each user.
 * Supports per-type channel preferences and quiet hours.
 */

import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const notificationPreferences = pgTable("notification_preferences", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  notification_type: text("notification_type").notNull(), // ai-flag, message, reminder, system
  channel: text("channel").notNull().default("in_app"), // in_app, email, sms
  enabled: boolean("enabled").notNull().default(true),
  quiet_hours_start: text("quiet_hours_start"), // HH:MM — null means no quiet hours
  quiet_hours_end: text("quiet_hours_end"), // HH:MM
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_notification_prefs_user").on(table.user_id),
]);
