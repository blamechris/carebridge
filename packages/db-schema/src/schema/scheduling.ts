/**
 * Appointment scheduling schema.
 *
 * Supports appointment booking, provider schedule templates, and schedule blocks.
 */

import { pgTable, text, integer, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";
import { users } from "./auth.js";
import { encryptedText } from "../encryption.js";

export const appointments = pgTable("appointments", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  provider_id: text("provider_id").notNull().references(() => users.id),
  appointment_type: text("appointment_type").notNull(), // follow_up, new_patient, procedure, telehealth
  start_time: text("start_time").notNull(),
  end_time: text("end_time").notNull(),
  status: text("status").notNull().default("scheduled"), // scheduled, confirmed, checked_in, completed, cancelled, no_show
  location: text("location"),
  reason: text("reason"),
  notes: encryptedText("notes"),
  encounter_id: text("encounter_id"),
  cancelled_at: text("cancelled_at"),
  cancelled_by: text("cancelled_by"),
  cancel_reason: text("cancel_reason"),
  // BullMQ job IDs for scheduled reminder delivery. Nullable — populated when
  // a future-dated appointment is booked and cleared when the appointment is
  // cancelled. Two fixed reminder offsets (24 h and 2 h before start_time)
  // are hardcoded per issue #333. See services/scheduling/src/reminders.ts.
  reminder_24h_job_id: text("reminder_24h_job_id"),
  reminder_2h_job_id: text("reminder_2h_job_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_appointments_patient").on(table.patient_id, table.start_time),
  index("idx_appointments_provider").on(table.provider_id, table.start_time),
  index("idx_appointments_status").on(table.status),
]);

export const providerSchedules = pgTable("provider_schedules", {
  id: text("id").primaryKey(),
  provider_id: text("provider_id").notNull().references(() => users.id),
  day_of_week: integer("day_of_week").notNull(), // 0=Sunday, 6=Saturday
  start_time: text("start_time").notNull(), // HH:MM format
  end_time: text("end_time").notNull(), // HH:MM format
  slot_duration_minutes: integer("slot_duration_minutes").notNull().default(30),
  location: text("location"),
  is_active: text("is_active").notNull().default("true"),
  effective_from: text("effective_from"),
  effective_until: text("effective_until"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_provider_schedules_provider").on(table.provider_id),
]);

export const scheduleBlocks = pgTable("schedule_blocks", {
  id: text("id").primaryKey(),
  provider_id: text("provider_id").notNull().references(() => users.id),
  start_time: text("start_time").notNull(),
  end_time: text("end_time").notNull(),
  reason: text("reason"), // vacation, meeting, blocked
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_schedule_blocks_provider").on(table.provider_id, table.start_time),
]);
