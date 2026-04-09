-- 0017_patient_ai_consent.sql
--
-- Phase D P1: per-patient consent capture for AI-assisted oversight.
--
-- The deterministic rules path does not require a row here — rules run
-- over data the patient has already agreed to share with their care
-- team. The LLM review path (and Phase A note extraction, Phase B
-- check-ins) DOES require an unrevoked row because it transmits derived
-- clinical context to an external processor (Anthropic) under the BAA.
--
-- Grants are append-only: revocation flips `revoked_at` + `revoked_by_user_id`
-- rather than deleting the row, preserving the audit trail.
--
-- Indexing:
--   idx_patient_ai_consent_active — primary hot-path index; answers
--     "does this patient currently consent to this scope?" with a
--     single index scan. The column order (patient_id, scope,
--     revoked_at, granted_at) matches the exact filter the review
--     worker issues before every LLM call.

CREATE TABLE IF NOT EXISTS "patient_ai_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "scope" text NOT NULL,
  "policy_version" text NOT NULL,
  "granted_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "granted_by_relationship" text NOT NULL,
  "granted_at" text NOT NULL,
  "revoked_at" text,
  "revoked_by_user_id" text,
  "revocation_reason" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_patient_ai_consent_active"
  ON "patient_ai_consent" ("patient_id", "scope", "revoked_at", "granted_at");
