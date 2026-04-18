-- Add `lifecycle_event` column to note_versions so the version history can
-- distinguish archive rows that share the same `version` number.
--
-- Background: signNote and cosignNote both call archiveVersion() with the
-- existing `clinical_notes.version` (they do not bump it — only amend does),
-- so a create -> sign -> cosign sequence produces two note_versions rows that
-- are identical except for saved_at/saved_by. `getVersionHistory` ordered by
-- `version` alone returned them in an unstable order with no way to label
-- which snapshot represented which state transition.
--
-- Column values used by application code:
--   "draft"    — draft edit archived by updateNote
--   "signed"   — archived at sign time by signNote
--   "cosigned" — archived at cosign time by cosignNote
--   "amended"  — archived at amend time by amendNote
--   "unknown"  — backfill default for any rows inserted before this column
--                existed; new rows always receive an explicit event.
--
-- Non-destructive: column is NOT NULL with a DEFAULT, so existing rows are
-- backfilled atomically. No separate data-migration script is needed.

ALTER TABLE "note_versions"
  ADD COLUMN IF NOT EXISTS "lifecycle_event" text NOT NULL DEFAULT 'unknown';
