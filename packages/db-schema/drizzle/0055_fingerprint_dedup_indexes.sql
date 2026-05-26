-- #1204: composite indexes covering the cross-source fingerprint dedup
-- lookups added by #1197 / #1191.
--
-- The Epic-connector persistence layer (services/epic-connector/src/sync/
-- persistence.ts) falls back to fingerprint matching when no FHIR
-- resource is registered yet. Each fingerprint query is shaped as
--   WHERE patient_id = $1 AND <coded-dim> = $2 [AND <temporal> = $3]
-- across encounters / diagnoses / allergies / medications / vitals.
--
-- The existing per-table indexes are wrong-shape for these queries:
--   idx_encounters_patient        (patient_id)              — leading-col only
--   idx_diagnoses_patient         (patient_id, status)      — wrong second col
--   idx_allergies_patient         (patient_id)              — leading-col only
--   idx_medications_patient       (patient_id, status)      — wrong second col
--   idx_vitals_patient_type       (patient_id, type, recorded_at)
--                                                           — type ≠ loinc_code
--
-- Partial WHERE NOT NULL keeps index size proportional to rows the
-- fingerprint query actually touches (Epic-sourced rows + any internal
-- rows that happen to carry a code), instead of indexing every NULL.
--
-- Plain CREATE INDEX (no CONCURRENTLY) matches the repo convention —
-- see 0034_gin_trigger_event_ids.sql for the rationale (Drizzle's
-- migrator wraps each migration in a transaction; CONCURRENTLY cannot
-- run inside a transaction).

CREATE INDEX IF NOT EXISTS "idx_encounters_dedup"
  ON "encounters" USING btree ("patient_id", "start_time", "encounter_type");

CREATE INDEX IF NOT EXISTS "idx_diagnoses_dedup_icd10"
  ON "diagnoses" USING btree ("patient_id", "icd10_code")
  WHERE "icd10_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_diagnoses_dedup_snomed"
  ON "diagnoses" USING btree ("patient_id", "snomed_code")
  WHERE "snomed_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_allergies_dedup_rxnorm"
  ON "allergies" USING btree ("patient_id", "rxnorm_code")
  WHERE "rxnorm_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_allergies_dedup_snomed"
  ON "allergies" USING btree ("patient_id", "snomed_code")
  WHERE "snomed_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_medications_dedup"
  ON "medications" USING btree ("patient_id", "rxnorm_code", "started_at")
  WHERE "rxnorm_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_vitals_dedup"
  ON "vitals" USING btree ("patient_id", "loinc_code", "recorded_at")
  WHERE "loinc_code" IS NOT NULL;
