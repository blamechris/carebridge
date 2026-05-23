-- #393: outbound FHIR Flag push tracking on clinical_flags.
--
-- When the epic-outbound-flags worker successfully POSTs a CareBridge
-- clinical_flag to Epic as a FHIR Flag resource, it records the Epic
-- resource id here so subsequent status changes (acknowledge / resolve
-- / dismiss) can be propagated via PUT rather than re-creating the
-- resource on Epic's side. NULL on rows that haven't been pushed (Epic
-- disabled locally, push failed, or push not yet processed).
ALTER TABLE "clinical_flags"
  ADD COLUMN IF NOT EXISTS "epic_flag_id" text;

ALTER TABLE "clinical_flags"
  ADD COLUMN IF NOT EXISTS "epic_org_iss" text;

ALTER TABLE "clinical_flags"
  ADD COLUMN IF NOT EXISTS "epic_pushed_at" text;

-- Most-recent push error, truncated to 1KiB by the writer. NULL when
-- the row has never failed or the most-recent push succeeded.
ALTER TABLE "clinical_flags"
  ADD COLUMN IF NOT EXISTS "epic_push_error" text;

CREATE INDEX IF NOT EXISTS "idx_clinical_flags_epic_flag_id"
  ON "clinical_flags" ("epic_flag_id");
