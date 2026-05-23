-- #392: per-user, per-Epic-org OAuth connection state.
--
-- Records the SMART on FHIR App Launch tokens a CareBridge user has
-- authorised against a given Epic organisation. One row per
-- (user_id, epic_org_iss) tuple — a clinician who covers shifts at
-- two hospitals on separate Epic instances has two rows.
--
-- Tokens are encrypted at rest by the application layer (the
-- application-level encryption hook used elsewhere for PHI columns).
-- The columns are declared `text` here — encryption is transparent to
-- the DB schema and applied via the same path as patient.mrn etc.
--
-- `id_token_subject` is the `sub` claim Epic returns on the id_token;
-- combined with `epic_org_iss` it gives a stable identity for the
-- Epic practitioner across sessions. `epic_practitioner_fhir_id` is
-- the FHIR Practitioner.id Epic includes in the user-context launch
-- response (also called `fhirUser` in the SMART spec).
CREATE TABLE IF NOT EXISTS "epic_user_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "epic_org_iss" text NOT NULL,
  "id_token_subject" text,
  "epic_practitioner_fhir_id" text,
  "epic_patient_fhir_id" text,
  "access_token_enc" text NOT NULL,
  "refresh_token_enc" text,
  "expires_at" text NOT NULL,
  "scopes" text NOT NULL,
  "launch_encounter_fhir_id" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "unique_user_epic_org" UNIQUE ("user_id", "epic_org_iss")
);

CREATE INDEX IF NOT EXISTS "idx_epic_user_connections_user"
  ON "epic_user_connections" ("user_id");

CREATE INDEX IF NOT EXISTS "idx_epic_user_connections_practitioner"
  ON "epic_user_connections" ("epic_practitioner_fhir_id");
