-- 0011_encrypt_clinical_narratives.sql
--
-- HIPAA: encrypt clinical narrative PHI fields at rest using AES-256-GCM
-- via the `encryptedText` / `encryptedJsonb` Drizzle custom types
-- (see packages/db-schema/src/encryption.ts).
--
-- The custom types map to a `text` column at the SQL level, so no
-- ALTER COLUMN TYPE statements are required for columns that were
-- already `text`. The JSONB `sections` columns on clinical_notes /
-- note_versions are converted to `text` to hold the ciphertext, because
-- encrypted bytes are not valid JSON and cannot live in a `jsonb` column.
--
-- Fields now encrypted:
--   diagnoses.description
--   allergies.allergen
--   allergies.reaction
--   medications.name
--   medications.brand_name
--   medications.notes
--   vitals.notes
--   lab_results.notes
--   procedures.notes
--   clinical_notes.sections      (jsonb -> text, encrypted JSON blob)
--   note_versions.sections       (jsonb -> text, encrypted JSON blob)
--
-- IMPORTANT — DATA MIGRATION REQUIRED:
-- Any rows that already exist in these tables are plaintext and will fail
-- to decrypt through the custom type (which expects the `iv:authTag:ct`
-- format produced by encrypt()). A one-time re-encryption script must run
-- against the live database to rewrite every existing row through the
-- encryption pipeline before application reads will succeed.
--
-- Run the re-encryption script AFTER applying this migration and BEFORE
-- any application reads against the affected tables:
--
--   DATABASE_URL=postgres://... \
--   PHI_ENCRYPTION_KEY=<64-hex> \
--     pnpm --filter @carebridge/db-schema encrypt:0011
--
-- Script source: packages/db-schema/src/encrypt-clinical-narratives.ts
-- Supports --dry-run and --table <name> flags; safe to re-run (idempotent).
-- Do not deploy this migration to an environment with existing PHI data
-- without running the script.

ALTER TABLE "clinical_notes"
  ALTER COLUMN "sections" SET DATA TYPE text USING "sections"::text;

ALTER TABLE "note_versions"
  ALTER COLUMN "sections" SET DATA TYPE text USING "sections"::text;
