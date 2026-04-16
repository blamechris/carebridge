-- Migration: Add updated_at column to failed_clinical_events.
--
-- The outbox reconciler recovery pass resets all status='processing' rows
-- back to 'pending' on each tick. Without a time guard, a concurrent pod's
-- in-flight rows (legitimately 'processing' right now) get stolen. The
-- updated_at column lets the recovery pass only reset rows whose last
-- status change is older than a stale-processing threshold (5 minutes),
-- ensuring in-flight rows from other pods are not disturbed.

ALTER TABLE failed_clinical_events
  ADD COLUMN IF NOT EXISTS updated_at text;
