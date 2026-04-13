-- Migration: Encrypt clinical events title/body at rest
--
-- The events table title and body columns may contain PHI (diagnosis names,
-- clinical alert descriptions, patient-identifying information). They are now
-- stored encrypted via the encryptedText custom type (AES-256-GCM with
-- per-value random IV).
--
-- No column type change needed — they remain TEXT columns. Encryption and
-- decryption are handled transparently at the application layer by the Drizzle
-- encryptedText custom type.
--
-- NOTE: Existing rows with plaintext title/body will need to be re-encrypted
-- via a backfill script. The encryptedText type's fromDriver will fail on
-- plaintext values — the backfill must read raw, encrypt, and write back.

-- This migration is a no-op at the SQL level; the schema change is in the
-- Drizzle schema definition (clinical-data.ts).
SELECT 1;
