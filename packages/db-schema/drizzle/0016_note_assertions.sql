-- 0016_note_assertions.sql
--
-- Phase A1: structured assertions extracted from clinical notes by the
-- AI oversight note-extractor.
--
-- The `payload` column stores the encryptedJsonb-encoded NoteAssertionsPayload
-- (see packages/shared-types/src/note-assertions.ts) at rest. Per the
-- encryptedJsonb custom type, ciphertext lives in a `text` column because
-- AES-256-GCM output is not valid JSON. JSONB query operators are
-- intentionally unavailable on this column — callers read the full row
-- and filter in application code.
--
-- The schema mirrors `clinical_notes` for indexability:
--   - idx_note_assertions_note: lookup by source note (1:1 in practice)
--   - idx_note_assertions_patient: chronological feed for a patient
--   - idx_note_assertions_status: monitor extraction failures
--
-- Foreign keys reference the source note and the patient. Both are
-- declared NOT NULL — an assertion row without a parent note has no
-- meaning.

CREATE TABLE IF NOT EXISTS "note_assertions" (
  "id" text PRIMARY KEY NOT NULL,
  "note_id" text NOT NULL REFERENCES "clinical_notes"("id"),
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "payload" text NOT NULL,
  "extraction_status" text NOT NULL,
  "error" text,
  "model_id" text,
  "prompt_version" text,
  "processing_time_ms" integer,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_note_assertions_note"
  ON "note_assertions" ("note_id");

CREATE INDEX IF NOT EXISTS "idx_note_assertions_patient"
  ON "note_assertions" ("patient_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_note_assertions_status"
  ON "note_assertions" ("extraction_status");
