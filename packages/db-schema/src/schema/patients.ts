import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, boolean, real, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";

export const patients = pgTable("patients", {
  id: text("id").primaryKey(),
  // Non-deterministic encryption (random IV per write) means identical names produce
  // different ciphertexts. The `name_hmac` column stores a deterministic HMAC-SHA256
  // digest enabling search/lookup without decryption.
  name: encryptedText("name").notNull(),
  name_hmac: text("name_hmac"),
  date_of_birth: encryptedText("date_of_birth"),
  biological_sex: text("biological_sex").default("unknown"),
  diagnosis: encryptedText("diagnosis"),
  notes: encryptedText("notes"),
  // Non-deterministic encryption (random IV per write) means identical MRNs produce
  // different ciphertexts. The `mrn_hmac` column stores a deterministic HMAC-SHA256
  // digest so the DB unique constraint can enforce MRN uniqueness.
  mrn: encryptedText("mrn"),
  mrn_hmac: text("mrn_hmac").unique(),
  insurance_id: encryptedText("insurance_id"),
  emergency_contact_name: encryptedText("emergency_contact_name"),
  emergency_contact_phone: encryptedText("emergency_contact_phone"),
  primary_provider_id: text("primary_provider_id"),
  allergy_status: text("allergy_status").notNull().default("unknown"),
  weight_kg: real("weight_kg"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const diagnoses = pgTable("diagnoses", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  icd10_code: text("icd10_code"),
  snomed_code: text("snomed_code"),
  description: encryptedText("description").notNull(),
  status: text("status").notNull().default("active"), // active, resolved, chronic
  onset_date: text("onset_date"),
  resolved_date: text("resolved_date"),
  diagnosed_by: text("diagnosed_by"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_diagnoses_patient").on(table.patient_id, table.status),
]);

export const allergies = pgTable("allergies", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  allergen: encryptedText("allergen").notNull(),
  snomed_code: text("snomed_code"),
  rxnorm_code: text("rxnorm_code"),
  reaction: encryptedText("reaction"),
  severity: text("severity"), // mild, moderate, severe
  // Tracks clinical verification of this allergy record: confirmed (verified reaction),
  // unconfirmed (reported but not verified), entered_in_error, or refuted (tested negative).
  verification_status: text("verification_status").notNull().default("unconfirmed"), // confirmed, unconfirmed, entered_in_error, refuted
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_allergies_patient").on(table.patient_id),
]);

/**
 * Clinical care-team roster displayed on the patient chart.
 *
 * Tracks which providers are clinically involved in a patient's care
 * (primary, specialist, nurse, coordinator) along with their specialty.
 * This is the source of truth for the "Care Team" section rendered in the
 * clinician-portal and patient-portal UIs.
 *
 * Referenced by:
 *  - patient-records service (care team listing on the chart)
 *  - ai-oversight context builder (assembling clinical context for reviews)
 *
 * NOT used for access control — see {@link careTeamAssignments} for RBAC.
 * A provider can appear here without having system access, and vice-versa.
 */
export const careTeamMembers = pgTable("care_team_members", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  provider_id: text("provider_id").notNull(),
  // CHECK constraint mirrors `careTeamMemberRoleSchema` in
  // packages/validators — see migration 0038_care_team_constraints.sql.
  role: text("role").notNull(), // "primary" | "specialist" | "nurse" | "coordinator"
  specialty: text("specialty"),
  is_active: boolean("is_active").notNull().default(true),
  started_at: text("started_at").notNull(),
  ended_at: text("ended_at"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_care_team_patient").on(table.patient_id, table.is_active),
  // Partial UNIQUE index — DB guardrail for #881 idempotency. App-layer
  // check in care-team.ts short-circuits before we ever hit this, but
  // the index defends against concurrent writers and direct SQL.
  uniqueIndex("idx_care_team_members_active_unique")
    .on(table.provider_id, table.patient_id)
    .where(sql`${table.is_active} = true`),
  check(
    "care_team_members_role_check",
    sql`${table.role} IN ('primary', 'specialist', 'nurse', 'coordinator')`,
  ),
]);

/**
 * RBAC access-control mapping: determines which users (clinicians) are
 * authorized to view or modify a patient's records in the system.
 *
 * Queried by the api-gateway RBAC middleware (`assertPatientAccess`) on
 * every patient-scoped API request. A row here grants a user access to
 * the patient; removing the row (setting `removed_at`) revokes it.
 *
 * Referenced by:
 *  - api-gateway rbac middleware (authorization checks)
 *
 * NOT the same as {@link careTeamMembers}, which is the clinical care-team
 * roster shown on the patient chart. A user may have system access without
 * appearing on the clinical care team, and a care-team member may not yet
 * have a corresponding access-control row.
 */
export const careTeamAssignments = pgTable("care_team_assignments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text("user_id").notNull(),
  patient_id: text("patient_id").notNull(),
  // CHECK constraint mirrors `careTeamAssignmentRoleSchema` in
  // packages/validators — see migration 0038_care_team_constraints.sql.
  role: text("role").notNull(), // "attending" | "consulting" | "nursing" | "covering"
  assigned_at: text("assigned_at").notNull().$defaultFn(() => new Date().toISOString()),
  removed_at: text("removed_at"), // null = active
}, (table) => [
  index("idx_care_team_assignments_user_patient").on(table.user_id, table.patient_id),
  index("idx_care_team_assignments_patient").on(table.patient_id),
  // Partial UNIQUE index — DB guardrail for #881 idempotency on the
  // RBAC table. Revoked rows (removed_at set) are excluded so the row
  // is retained for audit history.
  uniqueIndex("idx_care_team_assignments_active_unique")
    .on(table.user_id, table.patient_id)
    .where(sql`${table.removed_at} IS NULL`),
  check(
    "care_team_assignments_role_check",
    sql`${table.role} IN ('attending', 'consulting', 'nursing', 'covering')`,
  ),
]);
