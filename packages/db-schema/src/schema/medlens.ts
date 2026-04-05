/**
 * MedLens Integration Schema
 *
 * Supports patient-authorized sync between MedLens (local-first mobile app)
 * and CareBridge (clinical platform).
 */

import { pgTable, text, jsonb, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";
import { users } from "./auth.js";
import type { MedLensSyncScope } from "@carebridge/shared-types";

/**
 * Sync tokens issued to patients to authorize MedLens connectivity.
 *
 * Tokens are patient-scoped and carry explicit scopes for what MedLens
 * can read from or write to the patient's CareBridge record.
 */
export const medlensSyncTokens = pgTable("medlens_sync_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  // The patient (or their authorized representative) who created the token
  created_by: text("created_by").notNull().references(() => users.id),
  scopes: jsonb("scopes").$type<MedLensSyncScope[]>().notNull().default([]),
  expires_at: text("expires_at").notNull(),
  last_used_at: text("last_used_at"),
  revoked_at: text("revoked_at"),
  revoke_reason: text("revoke_reason"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_medlens_tokens_patient").on(table.patient_id),
  index("idx_medlens_tokens_token").on(table.token),
]);

/**
 * Audit log for MedLens sync operations.
 * Records every pull/push operation for HIPAA audit trail.
 */
export const medlensSyncLog = pgTable("medlens_sync_log", {
  id: text("id").primaryKey(),
  token_id: text("token_id").notNull().references(() => medlensSyncTokens.id),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  operation: text("operation").notNull(), // "export" | "import"
  records_transferred: text("records_transferred"), // JSON summary
  timestamp: text("timestamp").notNull(),
}, (table) => [
  index("idx_medlens_log_patient").on(table.patient_id, table.timestamp),
  index("idx_medlens_log_token").on(table.token_id),
]);
