-- Add verification_status to allergies table to distinguish confirmed,
-- unconfirmed, entered_in_error, and refuted allergy records.
ALTER TABLE "allergies" ADD COLUMN "verification_status" text NOT NULL DEFAULT 'unconfirmed';

-- Add allergy_status to patients table to distinguish NKDA (confirmed no
-- known drug allergies), unknown (never assessed), and has_allergies.
ALTER TABLE "patients" ADD COLUMN "allergy_status" text NOT NULL DEFAULT 'unknown';
