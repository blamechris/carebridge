/**
 * Phase A1: structured assertions extracted from clinical notes by the
 * AI oversight note-extractor.
 *
 * Each row holds the typed claims a single signed note made — symptoms
 * reported, symptoms denied, assessments, plan items, referenced
 * results — so deterministic contradiction and gap rules can reason
 * over them later (Phase A2).
 *
 * Storage: `payload` is encrypted at rest with the same encryptedJsonb
 * custom type used by `clinical_notes.sections`. The full extracted
 * structure round-trips through AES-256-GCM at the driver level.
 *
 * Provenance: every row records the model id and prompt version that
 * produced it, so retroactive comparisons are possible when prompts or
 * models change.
 *
 * Status: an extraction can fail in five distinct ways (see
 * NoteExtractionStatus). Rows are inserted regardless of status so
 * failed extractions are observable from the DB rather than silently
 * lost in worker logs.
 */
import { pgTable, text, integer, index } from "drizzle-orm/pg-core";
import { encryptedJsonb } from "../encryption.js";
import { clinicalNotes } from "./notes.js";
import { patients } from "./patients.js";
import type { NoteAssertionsPayload } from "@carebridge/shared-types";

const encryptedPayload = encryptedJsonb<NoteAssertionsPayload>();

export const noteAssertions = pgTable(
  "note_assertions",
  {
    id: text("id").primaryKey(),
    note_id: text("note_id")
      .notNull()
      .references(() => clinicalNotes.id),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id),
    /**
     * NoteAssertionsPayload — encrypted at rest. On rows where extraction
     * failed before any structured output was produced, this column holds
     * an empty payload (`{ symptoms_reported: [], ... }`) so consumers
     * never crash on null. The `extraction_status` column distinguishes.
     */
    payload: encryptedPayload("payload").notNull(),
    /**
     * One of: "success", "parse_failed", "llm_disabled", "llm_failed",
     * "sanitization_failed". Stored as text rather than enum so future
     * statuses can be added without an ALTER TYPE.
     */
    extraction_status: text("extraction_status").notNull(),
    /** Human-readable error message when extraction_status != "success". */
    error: text("error"),
    /** Model that produced the extraction. e.g. "claude-sonnet-4-6". */
    model_id: text("model_id"),
    /** Prompt version from packages/ai-prompts. */
    prompt_version: text("prompt_version"),
    /** Wall-clock processing time including retries and persistence. */
    processing_time_ms: integer("processing_time_ms"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_note_assertions_note").on(table.note_id),
    index("idx_note_assertions_patient").on(
      table.patient_id,
      table.created_at,
    ),
    index("idx_note_assertions_status").on(table.extraction_status),
  ],
);
