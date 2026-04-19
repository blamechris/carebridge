-- Prevent duplicate open clinical flags via partial unique indexes.
-- Closes the TOCTOU race window in flag-service.ts where concurrent
-- workers could both SELECT (no dup) then INSERT (two identical flags).

-- Ensure rule_id column exists. It is defined in the Drizzle schema
-- (packages/db-schema/src/schema/ai-flags.ts) but no prior migration
-- adds it, so `pnpm db:migrate` against a fresh DB would error on
-- the partial index below without this ALTER.
ALTER TABLE clinical_flags ADD COLUMN IF NOT EXISTS rule_id text;

-- Rule-based flags: only one open flag per (patient, rule) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_open_rule_dedup
  ON clinical_flags (patient_id, rule_id)
  WHERE status = 'open' AND rule_id IS NOT NULL;

-- LLM-generated flags (no rule_id): only one open flag per
-- (patient, category, severity) at a time. Application-level 24h
-- window check remains as an additional safeguard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_open_llm_dedup
  ON clinical_flags (patient_id, category, severity)
  WHERE status = 'open' AND rule_id IS NULL;
