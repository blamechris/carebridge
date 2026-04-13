import { pgTable, text, real, index, jsonb } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";
import { patients } from "./patients.js";

export const medications = pgTable("medications", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  name: encryptedText("name").notNull(),
  brand_name: encryptedText("brand_name"),
  dose_amount: real("dose_amount"),
  dose_unit: text("dose_unit"),
  route: text("route"),
  frequency: text("frequency"),
  status: text("status").notNull().default("active"),
  started_at: text("started_at"),
  ended_at: text("ended_at"),
  prescribed_by: text("prescribed_by"),
  notes: encryptedText("notes"),
  rxnorm_code: text("rxnorm_code"),
  ordering_provider_id: text("ordering_provider_id"),
  encounter_id: text("encounter_id"),
  source_system: text("source_system").default("internal"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_medications_patient").on(table.patient_id, table.status),
]);

export const medLogs = pgTable("med_logs", {
  id: text("id").primaryKey(),
  medication_id: text("medication_id").notNull().references(() => medications.id),
  administered_at: text("administered_at").notNull(),
  dose_amount: real("dose_amount"),
  dose_unit: text("dose_unit"),
  administered_by: text("administered_by"),
  notes: text("notes"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_med_logs_med").on(table.medication_id, table.administered_at),
]);

export const vitals = pgTable("vitals", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  recorded_at: text("recorded_at").notNull(),
  type: text("type").notNull(),
  loinc_code: text("loinc_code"),
  value_primary: real("value_primary").notNull(),
  value_secondary: real("value_secondary"),
  unit: text("unit").notNull(),
  notes: encryptedText("notes"),
  provider_id: text("provider_id"),
  encounter_id: text("encounter_id"),
  source_system: text("source_system").default("internal"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_vitals_patient_type").on(table.patient_id, table.type, table.recorded_at),
]);

export const labPanels = pgTable("lab_panels", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  panel_name: text("panel_name").notNull(),
  ordered_by: text("ordered_by"),
  collected_at: text("collected_at"),
  reported_at: text("reported_at"),
  notes: text("notes"),
  ordering_provider_id: text("ordering_provider_id"),
  encounter_id: text("encounter_id"),
  source_system: text("source_system").default("internal"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_lab_panels_patient").on(table.patient_id, table.collected_at),
]);

export const labResults = pgTable("lab_results", {
  id: text("id").primaryKey(),
  panel_id: text("panel_id").notNull().references(() => labPanels.id),
  test_name: text("test_name").notNull(),
  test_code: text("test_code"),
  value: real("value").notNull(),
  unit: text("unit").notNull(),
  reference_low: real("reference_low"),
  reference_high: real("reference_high"),
  flag: text("flag"),
  notes: encryptedText("notes"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_lab_results_panel").on(table.panel_id),
  index("idx_lab_results_name").on(table.test_name, table.created_at),
]);

export const procedures = pgTable("procedures", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  name: text("name").notNull(),
  cpt_code: text("cpt_code"),
  icd10_codes: jsonb("icd10_codes").$type<string[]>(),
  status: text("status").notNull().default("scheduled"),
  performed_at: text("performed_at"),
  performed_by: text("performed_by"),
  provider_id: text("provider_id"),
  encounter_id: text("encounter_id"),
  notes: encryptedText("notes"),
  source_system: text("source_system").default("internal"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_procedures_patient").on(table.patient_id, table.status),
]);

export const failedClinicalEvents = pgTable("failed_clinical_events", {
  id: text("id").primaryKey(),
  event_type: text("event_type").notNull(),
  event_payload: jsonb("event_payload").notNull(),
  error_message: text("error_message").notNull(),
  status: text("status").notNull().default("pending"),
  retry_count: real("retry_count").notNull().default(0),
  created_at: text("created_at").notNull(),
  retried_at: text("retried_at"),
}, (table) => [
  index("idx_failed_clinical_events_status").on(table.status, table.created_at),
]);

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  occurred_at: text("occurred_at").notNull(),
  category: text("category").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  severity: text("severity").notNull().default("info"),
  provider_id: text("provider_id"),
  encounter_id: text("encounter_id"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_events_patient").on(table.patient_id, table.occurred_at),
]);
