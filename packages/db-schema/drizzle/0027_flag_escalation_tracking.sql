-- Migration: Add escalation tracking to clinical_flags
--
-- The escalation worker re-notifies care team members for critical/warning
-- flags that remain unacknowledged past their escalation threshold.
-- `escalation_count` caps the number of re-notifications at 3 so that
-- chronic unacknowledged flags do not generate unbounded alert fatigue.
-- `last_escalated_at` is used to ensure we wait at least one full
-- escalation interval between re-notifications for the same flag.

ALTER TABLE clinical_flags
  ADD COLUMN IF NOT EXISTS escalation_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE clinical_flags
  ADD COLUMN IF NOT EXISTS last_escalated_at TEXT;

-- Composite index supports the escalation worker's hot query:
-- find open, unacknowledged flags by severity that are eligible to escalate.
CREATE INDEX IF NOT EXISTS idx_flags_escalation_scan
  ON clinical_flags (severity, status, acknowledged_at, escalation_count);
