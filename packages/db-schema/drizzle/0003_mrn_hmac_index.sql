-- Add mrn_hmac column: deterministic HMAC-SHA256 of the MRN for uniqueness enforcement.
-- Non-deterministic encryption prevents unique constraints on the ciphertext column,
-- so this companion column stores a stable digest that the DB can index.

ALTER TABLE "patients"
  ADD COLUMN "mrn_hmac" text;

-- Unique constraint for MRN uniqueness via HMAC digest.
ALTER TABLE "patients"
  ADD CONSTRAINT "patients_mrn_hmac_unique" UNIQUE ("mrn_hmac");
