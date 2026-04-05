import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  type: text("type").notNull(), // ai-flag, message, reminder, system
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"), // deep link to the relevant resource
  related_flag_id: text("related_flag_id"),
  is_read: boolean("is_read").notNull().default(false),
  created_at: text("created_at").notNull(),
  read_at: text("read_at"),
}, (table) => [
  index("idx_notifications_user").on(table.user_id, table.is_read, table.created_at),
]);
