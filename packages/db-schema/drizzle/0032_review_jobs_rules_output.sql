-- Migration: Persist full rule-evaluation output on review_jobs.
--
-- Previously review_jobs only stored rules_fired as an array of rule IDs.
-- For forensic / regulatory audit (HIPAA §164.308(a)(1)(ii)(D), §164.312(b))
-- that is not enough: when a decision is challenged we need the severity,
-- category, matched-drug context, rationale, and notify_specialties that
-- each rule produced — not just the rule's static ID.
--
-- rules_output is a jsonb array of RuleFlag entries (see packages/shared-
-- types for the canonical shape). Nullable default '[]' keeps pre-existing
-- rows valid; new writes always populate.

ALTER TABLE review_jobs
  ADD COLUMN IF NOT EXISTS rules_output jsonb NOT NULL DEFAULT '[]';
