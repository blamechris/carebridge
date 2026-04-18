-- Encrypt lab result and vital sign numeric fields at the application layer.
-- Column types change from real to text because encrypted values are ciphertext strings.
-- After running this migration, execute the re-encrypt-phi script to encrypt existing
-- plaintext rows: pnpm --filter @carebridge/scripts re-encrypt-phi

-- Vitals: value_primary, value_secondary
ALTER TABLE "vitals" ALTER COLUMN "value_primary" SET DATA TYPE text USING value_primary::text;
ALTER TABLE "vitals" ALTER COLUMN "value_secondary" SET DATA TYPE text USING value_secondary::text;

-- Lab results: value, reference_low, reference_high, flag (flag was already text but
-- now uses application-layer encryption via encryptedText)
ALTER TABLE "lab_results" ALTER COLUMN "value" SET DATA TYPE text USING value::text;
ALTER TABLE "lab_results" ALTER COLUMN "reference_low" SET DATA TYPE text USING reference_low::text;
ALTER TABLE "lab_results" ALTER COLUMN "reference_high" SET DATA TYPE text USING reference_high::text;
-- flag is already text, no type change needed; encryption is handled at the ORM layer
