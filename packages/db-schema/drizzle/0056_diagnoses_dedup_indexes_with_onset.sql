-- #1211: extend the diagnoses dedup indexes added in 0055 (#1204) to
-- carry `onset_date` as the trailing column, mirroring the
-- (patient_id, coded-dim, temporal) shape used by
--   idx_medications_dedup (patient_id, rxnorm_code, started_at)
--   idx_vitals_dedup      (patient_id, loinc_code,  recorded_at)
--
-- The fingerprint query in services/epic-connector/src/sync/persistence.ts
-- (findDiagnosisByFingerprint) is shaped as:
--   WHERE patient_id = $1 AND <icd10|snomed>_code = $2 AND onset_date = $3
-- The 0055 two-column index could only cover the leading two predicates;
-- the planner had to recheck onset_date against the heap. The
-- three-column shape lets the planner satisfy the full predicate from
-- the index alone, and remains usable for the two-column predicate
-- (icd10/snomed lookup without an onset filter) via a prefix scan.
--
-- DROP the 0055 variants first — CREATE INDEX IF NOT EXISTS would
-- otherwise no-op when the narrower index of the same name is present.
-- Partial WHERE NOT NULL is preserved so the index only covers rows
-- the fingerprint query actually targets (Epic-sourced rows + any
-- internal rows that happen to carry a code).
--
-- Plain CREATE INDEX (no CONCURRENTLY) matches the repo convention —
-- see 0055/0034 for the rationale (Drizzle wraps each migration in
-- a transaction; CONCURRENTLY cannot run inside one).

DROP INDEX IF EXISTS "idx_diagnoses_dedup_icd10";
DROP INDEX IF EXISTS "idx_diagnoses_dedup_snomed";

CREATE INDEX IF NOT EXISTS "idx_diagnoses_dedup_icd10"
  ON "diagnoses" USING btree ("patient_id", "icd10_code", "onset_date")
  WHERE "icd10_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_diagnoses_dedup_snomed"
  ON "diagnoses" USING btree ("patient_id", "snomed_code", "onset_date")
  WHERE "snomed_code" IS NOT NULL;
