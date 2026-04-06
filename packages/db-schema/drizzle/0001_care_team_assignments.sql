-- Care-team assignment table for RBAC patient-scoping.
-- This table controls which users (clinicians) have system-level access
-- to a given patient's records, enforced by the api-gateway RBAC middleware.
-- See also: care_team_members (clinical display of the patient's care team).

CREATE TABLE IF NOT EXISTS "care_team_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "patient_id" text NOT NULL,
  "role" text NOT NULL,
  "assigned_at" text NOT NULL,
  "removed_at" text
);

CREATE INDEX IF NOT EXISTS "idx_care_team_assignments_user_patient"
  ON "care_team_assignments" USING btree ("user_id", "patient_id");
CREATE INDEX IF NOT EXISTS "idx_care_team_assignments_patient"
  ON "care_team_assignments" USING btree ("patient_id");
