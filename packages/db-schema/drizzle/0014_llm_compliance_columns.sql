-- LLM compliance columns: persist redacted prompt for breach forensics,
-- and capture confidence + human-review gating on clinical_flags.

ALTER TABLE review_jobs ADD COLUMN redacted_prompt text;
ALTER TABLE review_jobs ADD COLUMN redaction_audit jsonb;

ALTER TABLE clinical_flags ADD COLUMN confidence integer;
ALTER TABLE clinical_flags ADD COLUMN requires_human_review integer NOT NULL DEFAULT 1;
