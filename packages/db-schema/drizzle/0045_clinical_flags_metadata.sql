-- #1039: clinical_flags.metadata column so RuleFlag.metadata is queryable
-- per-flag instead of requiring a join through review_jobs.rules_output.
--
-- PR #1022 added `RuleFlag.metadata?: Record<string, unknown>` and
-- CROSS-STEROID-PCP-001 emits `{ duration_known: boolean }` (extended to
-- `chronic_marked` in #1023). Today that telemetry only survives via
-- `review_jobs.rules_output` (jsonb<RuleFlag[]>), which forces every
-- FP-rate query to join clinical_flags → review_jobs.flags_generated and
-- unnest rules_output. Adding the column to clinical_flags lets dashboards
-- and ad-hoc analysis filter or group on metadata directly.
--
-- Stored as jsonb so future per-rule keys can be added without schema
-- migrations. Nullable because LLM-path flags currently have no metadata
-- and existing rows pre-#1039 will be NULL until a backfill runs.

ALTER TABLE clinical_flags ADD COLUMN IF NOT EXISTS metadata jsonb;
