import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(), // patient, nurse, physician, specialist, admin
  patient_id: text("patient_id"), // links patient users to their patient record
  specialty: text("specialty"),
  department: text("department"),
  is_active: boolean("is_active").notNull().default(true),
  mfa_secret: encryptedText("mfa_secret"), // encrypted TOTP secret, null if MFA not set up
  mfa_enabled: boolean("mfa_enabled").default(false),
  recovery_codes: text("recovery_codes"), // JSON array of hashed recovery codes
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").notNull(),
  last_active_at: text("last_active_at"),
  /** Opaque 32-byte hex token used to issue a replacement session without re-authentication. */
  refresh_token: text("refresh_token"),
}, (table) => [
  index("idx_sessions_user").on(table.user_id),
  index("idx_sessions_expires").on(table.expires_at),
  index("idx_sessions_refresh_token").on(table.refresh_token),
]);

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  action: text("action").notNull(), // read, create, update, delete
  resource_type: text("resource_type").notNull(), // patient, vital, note, etc.
  resource_id: text("resource_id").notNull(),
  procedure_name: text("procedure_name"), // tRPC procedure name, e.g. "patients.getById"
  patient_id: text("patient_id"), // explicit patient ID for HIPAA audit trails
  details: text("details"), // JSON string of additional context
  ip_address: text("ip_address"),
  timestamp: text("timestamp").notNull(),
}, (table) => [
  index("idx_audit_user").on(table.user_id, table.timestamp),
  index("idx_audit_resource").on(table.resource_type, table.resource_id),
  index("idx_audit_patient").on(table.patient_id, table.timestamp),
]);
