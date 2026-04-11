-- Migration: Add HTTP status / success / error columns to audit_log
--
-- HIPAA § 164.312(b) requires audit controls sufficient to distinguish
-- successful access from denied/failed attempts. Without these fields we
-- cannot detect attack patterns such as repeated 401/403 probes.
--
-- Columns are nullable so pre-existing rows (which have no recorded
-- outcome) remain valid. New writes from the audit middleware populate
-- all three fields.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS http_status_code INTEGER;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS success BOOLEAN;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_success_timestamp
  ON audit_log (success, timestamp);
