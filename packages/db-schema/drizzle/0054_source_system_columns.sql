-- #1190: source_system provenance columns for encounters/diagnoses/allergies.
--
-- The medications, vitals, lab_panels, and procedures tables already carry
-- a source_system text column (DEFAULT 'internal') so callers can answer
-- "where did this row come from?" without joining through fhir_resources.
-- These three tables were the only remaining gaps; Epic-sourced rows here
-- are currently indistinguishable from CareBridge-originated rows at the
-- row level, which blocks WHERE source_system = 'epic' reporting and
-- cross-source dedup.
--
-- Pattern A from docs/migration-patterns.md, special case: the DEFAULT
-- 'internal' populates every existing row in the same ADD COLUMN
-- statement, so the pre-clean step is unnecessary — the default IS the
-- cleanup. No CHECK constraint needed today; downstream code already
-- treats source_system as an open-set tag ("internal", "epic",
-- "fhir_import").
--
-- Pure additive — no NOT VALID + VALIDATE dance required. Safe on a
-- populated DB: PostgreSQL records the default in pg_attribute and
-- existing rows are filled in-place.
ALTER TABLE encounters ADD COLUMN source_system TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE diagnoses  ADD COLUMN source_system TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE allergies  ADD COLUMN source_system TEXT NOT NULL DEFAULT 'internal';
