-- Encrypt patients.name: change column to store AES-256-GCM ciphertext and add
-- name_hmac for deterministic search without decryption.
-- The column type stays "text" (encryptedText is a Drizzle customType over text),
-- so no ALTER COLUMN TYPE is needed — encryption is handled at the application layer.
-- Existing plaintext rows must be re-encrypted via a one-time data migration script
-- before deploying application code that expects ciphertext in this column.

ALTER TABLE "patients"
  ADD COLUMN "name_hmac" text;
