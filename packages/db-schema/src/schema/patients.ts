import crypto from "node:crypto";
import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";

export const patients = pgTable("patients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  date_of_birth: encryptedText("date_of_birth"),
  biological_sex: text("biological_sex").default("unknown"),
  diagnosis: text("diagnosis"),
  notes: text("notes"),
  // NOTE: Non-deterministic encryption (random IV per write) means identical MRNs produce
  // different ciphertexts. The DB unique constraint cannot enforce MRN uniqueness on the
  // ciphertext. This is an intentional security trade-off — application-level dedup is
  // required before insert to prevent duplicate MRNs.
  mrn: encryptedText("mrn"),
  insurance_id: encryptedText("insurance_id"),
  emergency_contact_name: encryptedText("emergency_contact_name"),
  emergency_contact_phone: encryptedText("emergency_contact_phone"),
  primary_provider_id: text("primary_provider_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const diagnoses = pgTable("diagnoses", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  icd10_code: text("icd10_code"),
  description: text("description").notNull(),
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
  allergen: text("allergen").notNull(),
  reaction: text("reaction"),
  severity: text("severity"), // mild, moderate, severe
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_allergies_patient").on(table.patient_id),
]);

/**
 * Clinical care-team roster displayed on the patient chart.
 * Tracks which providers are clinically responsible for the patient
 * (primary, specialist, nurse, coordinator) and their specialty.
 *
 * NOT used for access control — see `care_team_assignments` for RBAC scoping.
 */
export const careTeamMembers = pgTable("care_team_members", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  provider_id: text("provider_id").notNull(),
  role: text("role").notNull(), // "primary", "specialist", "nurse", "coordinator"
  specialty: text("specialty"),
  is_active: boolean("is_active").notNull().default(true),
  started_at: text("started_at").notNull(),
  ended_at: text("ended_at"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_care_team_patient").on(table.patient_id, table.is_active),
]);

/**
 * RBAC access-control table: determines which users (clinicians) are
 * authorized to view/modify a patient's records in the system.
 * Queried by the api-gateway RBAC middleware (`assertPatientAccess`).
 *
 * NOT the same as `care_team_members`, which is the clinical care-team
 * roster shown on the patient chart. A user may be on the access list
 * without appearing on the clinical care team and vice-versa.
 */
export const careTeamAssignments = pgTable("care_team_assignments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_id: text("user_id").notNull(),
  patient_id: text("patient_id").notNull(),
  role: text("role").notNull(), // "attending", "consulting", "nursing", etc.
  assigned_at: text("assigned_at").notNull().$defaultFn(() => new Date().toISOString()),
  removed_at: text("removed_at"), // null = active
}, (table) => [
  index("idx_care_team_assignments_user_patient").on(table.user_id, table.patient_id),
  index("idx_care_team_assignments_patient").on(table.patient_id),
]);
