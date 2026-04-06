import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(), // patient, nurse, physician, specialist, admin
  specialty: text("specialty"),
  department: text("department"),
  is_active: boolean("is_active").notNull().default(true),
  mfa_secret: text("mfa_secret"), // encrypted TOTP secret, null if MFA not set up
  mfa_enabled: boolean("mfa_enabled").default(false),
  recovery_codes: text("recovery_codes"), // JSON array of hashed recovery codes
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  expires_at: text("expires_at").notNull(),
}, (table) => [
  index("idx_sessions_user").on(table.user_id),
]);

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  action: text("action").notNull(), // read, create, update, delete
  resource_type: text("resource_type").notNull(), // patient, vital, note, etc.
  resource_id: text("resource_id").notNull(),
  details: text("details"), // JSON string of additional context
  ip_address: text("ip_address"),
  timestamp: text("timestamp").notNull(),
}, (table) => [
  index("idx_audit_user").on(table.user_id, table.timestamp),
  index("idx_audit_resource").on(table.resource_type, table.resource_id),
]);
