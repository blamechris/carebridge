-- Migration: Encrypt notification title/body at rest and add summary_safe column
--
-- The title and body columns may contain PHI (patient names, diagnoses in flag
-- summaries). They are now stored encrypted via encryptedText custom type.
-- The summary_safe column provides a PHI-free string suitable for lock-screen
-- push notification previews.
--
-- NOTE: Existing rows with plaintext title/body will need to be re-encrypted
-- via a backfill script. The encryptedText type's fromDriver will fail on
-- plaintext values — the backfill must read raw, encrypt, and write back.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS summary_safe TEXT;

-- No column type change needed for title/body — they remain TEXT columns.
-- The encryption/decryption is handled transparently at the application layer
-- by the Drizzle encryptedText custom type (AES-256-GCM with per-value random IV).
