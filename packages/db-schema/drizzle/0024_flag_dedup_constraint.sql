-- Prevent duplicate open clinical flags via partial unique indexes.
-- Closes the TOCTOU race window in flag-service.ts where concurrent
-- workers could both SELECT (no dup) then INSERT (two identical flags).

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
