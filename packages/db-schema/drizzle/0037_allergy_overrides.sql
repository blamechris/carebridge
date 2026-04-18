-- Issue #233 — Allergy override audit trail with structured justification.
--
-- Until now the only way to "override" an allergy warning was to dismiss the
-- resulting clinical_flag with a free-text `dismiss_reason`. That field is
-- optional, uncategorised, and insufficient for HIPAA quality review:
-- reviewers can't aggregate overrides by reason, can't detect patterns
-- ("why does Dr. X override penicillin allergies 40% of the time?"), and
-- can't reliably feed override status back into the rule layer to suppress
-- repeat flags for an allergy-drug pair the clinician has already cleared.
--
-- This table is the system of record for structured allergy overrides:
--   - `override_reason` is an enum constrained to clinically meaningful
--     categories so overrides can be aggregated for quality review.
--   - `clinical_justification` is required free-form narrative (min 10 chars
--     enforced in the Zod layer, non-empty enforced here) so there's always
--     a human-readable rationale alongside the categorised reason.
--   - Every row represents a single override event; rows are PERMANENT —
--     deletion is not a supported operation. Re-overriding the same flag
--     inserts a new row.
--
-- Downstream consumers:
--   - Rule layer (checkAllergyMedication): reads resolved_overrides and
--     suppresses flags for already-overridden allergy-drug pairs.
--   - Audit log: a separate `audit_log` row is written in the same
--     transaction as the override insert so reviewers can reconstruct who
--     overrode what and when.

-- Constrained reason enum. Lives as a CHECK rather than a pg enum type
-- so future additions don't require `ALTER TYPE ... ADD VALUE` migrations
-- (which cannot run inside transactions in older Postgres versions).
CREATE TABLE IF NOT EXISTS "allergy_overrides" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  -- Nullable: contraindication overrides may reference a flag that derives
  -- from a cross-reactivity match without a specific patient_allergies row
  -- (e.g. a medication-class warning flagged without a documented allergy).
  "allergy_id" text REFERENCES "allergies"("id"),
  "flag_id" text NOT NULL REFERENCES "clinical_flags"("id"),
  "overridden_by" text NOT NULL REFERENCES "users"("id"),
  "override_reason" text NOT NULL,
  "clinical_justification" text NOT NULL,
  "overridden_at" text NOT NULL,
  CONSTRAINT "allergy_overrides_reason_check" CHECK (
    "override_reason" IN (
      'mild_reaction_ok',
      'patient_tolerated_previously',
      'benefit_exceeds_risk',
      'desensitized',
      'misdiagnosed_allergy',
      'other'
    )
  ),
  CONSTRAINT "allergy_overrides_justification_nonempty"
    CHECK (length(btrim("clinical_justification")) > 0)
);

-- Patient-scoped lookup (context-builder joins on patient_id).
CREATE INDEX IF NOT EXISTS "idx_allergy_overrides_patient"
  ON "allergy_overrides" ("patient_id", "overridden_at");

-- Allergy-scoped lookup (rule layer joins on allergy_id to check for
-- prior overrides of the same allergy-drug pair).
CREATE INDEX IF NOT EXISTS "idx_allergy_overrides_allergy"
  ON "allergy_overrides" ("allergy_id")
  WHERE "allergy_id" IS NOT NULL;

-- Flag-scoped lookup (audit queries: "was this flag overridden?").
CREATE INDEX IF NOT EXISTS "idx_allergy_overrides_flag"
  ON "allergy_overrides" ("flag_id");
