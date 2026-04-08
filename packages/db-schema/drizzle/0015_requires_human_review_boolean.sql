-- Convert clinical_flags.requires_human_review from integer 0/1 to a proper boolean.

ALTER TABLE clinical_flags ALTER COLUMN requires_human_review DROP DEFAULT;
ALTER TABLE clinical_flags ALTER COLUMN requires_human_review TYPE boolean USING (requires_human_review::int <> 0);
ALTER TABLE clinical_flags ALTER COLUMN requires_human_review SET DEFAULT true;
