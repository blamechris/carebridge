import { pgTable, text, integer, real, index } from "drizzle-orm/pg-core";
import { encryptedJsonb } from "../encryption.js";
import { patients } from "./patients.js";

// NoteSection[] stored encrypted at rest. Ciphertext lives in a text column
// because encrypted bytes are not valid JSON; JSONB operators are unavailable
// on this column.
const encryptedSections = encryptedJsonb<unknown>();

export const clinicalNotes = pgTable("clinical_notes", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  provider_id: text("provider_id").notNull(),
  encounter_id: text("encounter_id"),
  template_type: text("template_type").notNull(), // soap, progress, h_and_p, discharge, consult
  sections: encryptedSections("sections").notNull(), // NoteSection[] — encrypted at rest
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
  sections: encryptedSections("sections").notNull(),
  saved_at: text("saved_at").notNull(),
  saved_by: text("saved_by").notNull(),
  // Labels which state transition produced this archive row. Distinguishes
  // otherwise-identical snapshots taken at the same `version` number —
  // specifically sign/cosign both archive at `existing.version` without
  // bumping it, so without this column a create→sign→cosign trail cannot
  // be told apart in `getVersionHistory`.
  // Values: "draft" | "signed" | "cosigned" | "amended" | "unknown"
  // "unknown" is only used as the backfill default for rows inserted before
  // this column existed; all new rows receive an explicit event.
  lifecycle_event: text("lifecycle_event").notNull().default("unknown"),
}, (table) => [
  index("idx_note_versions").on(table.note_id, table.version),
]);
