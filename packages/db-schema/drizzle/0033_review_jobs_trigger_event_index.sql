-- Migration: Index review_jobs.(trigger_event_id, status) for the idempotency probe.
--
-- PR #495 added a pre-insert check in services/ai-oversight/src/services/
-- review-service.ts that asks "does a completed review_jobs row already
-- exist for this trigger_event_id?" to suppress duplicate reviews when
-- BullMQ redelivers a job (worker crash / stalled-scan reclaim) or the
-- outbox reconciler replays the same event:
--
--   SELECT id, status FROM review_jobs
--   WHERE trigger_event_id = $1 AND status = 'completed'
--   LIMIT 1;
--
-- The only pre-existing index on review_jobs is
-- idx_review_jobs_patient(patient_id, status), which does not support
-- this lookup — so every probe falls back to a sequential scan. The
-- table is append-only and bound by the 7-year HIPAA retention window
-- (see docs/hipaa-retention.md), so the per-probe cost grows linearly
-- forever without an index.
--
-- A composite btree on (trigger_event_id, status) supports both the
-- equality-then-equality probe and any future queries that filter by
-- trigger_event_id alone (btree index leftmost-prefix rule).

CREATE INDEX IF NOT EXISTS idx_review_jobs_trigger_event
  ON review_jobs (trigger_event_id, status);
