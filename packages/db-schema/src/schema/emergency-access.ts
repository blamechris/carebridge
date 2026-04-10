/**
 * Break-the-glass emergency access schema.
 *
 * Allows providers to access patient records they're not assigned to in
 * emergencies, with mandatory justification and time-limited access.
 * All emergency access is prominently audit-logged and compliance-notified.
 */

import { pgTable, text, index } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { patients } from "./patients.js";
import { encryptedText } from "../encryption.js";

export const emergencyAccess = pgTable("emergency_access", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  justification: encryptedText("justification").notNull(), // encrypted — sensitive reasoning
  granted_at: text("granted_at").notNull(),
  expires_at: text("expires_at").notNull(),
  revoked_at: text("revoked_at"),
  revoked_by: text("revoked_by"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_emergency_access_user").on(table.user_id),
  index("idx_emergency_access_patient").on(table.patient_id),
  index("idx_emergency_access_expires").on(table.expires_at),
]);
