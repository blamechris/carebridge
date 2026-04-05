import { pgTable, text, integer, real, jsonb, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

export const clinicalNotes = pgTable("clinical_notes", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  provider_id: text("provider_id").notNull(),
  encounter_id: text("encounter_id"),
  template_type: text("template_type").notNull(), // soap, progress, h_and_p, discharge, consult
  sections: jsonb("sections").notNull(), // NoteSection[]
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"), // draft, signed, cosigned, amended
  signed_at: text("signed_at"),
  signed_by: text("signed_by"),
  cosigned_at: text("cosigned_at"),
  cosigned_by: text("cosigned_by"),
  copy_forward_score: real("copy_forward_score"),
  source_system: text("source_system").default("internal"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_notes_patient").on(table.patient_id, table.created_at),
  index("idx_notes_provider").on(table.provider_id, table.created_at),
  index("idx_notes_status").on(table.status),
]);

export const noteVersions = pgTable("note_versions", {
  id: text("id").primaryKey(),
  note_id: text("note_id").notNull().references(() => clinicalNotes.id),
  version: integer("version").notNull(),
  sections: jsonb("sections").notNull(),
  saved_at: text("saved_at").notNull(),
  saved_by: text("saved_by").notNull(),
}, (table) => [
  index("idx_note_versions").on(table.note_id, table.version),
]);
