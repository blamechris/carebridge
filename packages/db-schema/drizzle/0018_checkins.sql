-- 0018_checkins.sql
--
-- Phase B1: patient & family check-in templates and submissions.
--
-- Templates are a versioned library of structured symptom surveys the
-- patient portal renders; submissions are the immutable history of
-- answers. Responses are stored as encrypted JSON because they contain
-- patient-reported PHI (symptom descriptions, adherence, etc.).
--
-- A submission emits a `checkin.submitted` ClinicalEvent on the
-- clinical-events BullMQ queue so the ai-oversight worker can run
-- Phase B4 red-flag rules against responses + the patient's full
-- clinical context.

CREATE TABLE IF NOT EXISTS "check_in_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "version" integer NOT NULL DEFAULT 1,
  "questions" text NOT NULL,
  "target_condition" text NOT NULL,
  "frequency" text NOT NULL,
  "published_at" text,
  "retired_at" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_checkin_templates_slug_version"
  ON "check_in_templates" ("slug", "version");

CREATE INDEX IF NOT EXISTS "idx_checkin_templates_target"
  ON "check_in_templates" ("target_condition");

CREATE TABLE IF NOT EXISTS "check_ins" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "template_id" text NOT NULL REFERENCES "check_in_templates"("id"),
  "template_version" integer NOT NULL,
  "submitted_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "submitted_by_relationship" text NOT NULL,
  "responses" text NOT NULL,
  "red_flag_hits" text NOT NULL DEFAULT '[]',
  "submitted_at" text NOT NULL,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_check_ins_patient"
  ON "check_ins" ("patient_id", "submitted_at");

CREATE INDEX IF NOT EXISTS "idx_check_ins_template"
  ON "check_ins" ("template_id", "template_version");

CREATE INDEX IF NOT EXISTS "idx_check_ins_submitter"
  ON "check_ins" ("submitted_by_user_id");
