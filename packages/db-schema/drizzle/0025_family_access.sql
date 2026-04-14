-- Family access tables: relationships and invites
-- See issue #305 for security context

CREATE TABLE IF NOT EXISTS "family_relationships" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "users"("id"),
  "caregiver_id" text NOT NULL REFERENCES "users"("id"),
  "relationship_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "granted_at" text NOT NULL,
  "revoked_at" text,
  "revoked_by" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_family_rel_patient" ON "family_relationships" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_family_rel_caregiver" ON "family_relationships" ("caregiver_id");
CREATE INDEX IF NOT EXISTS "idx_family_rel_status" ON "family_relationships" ("status");

CREATE TABLE IF NOT EXISTS "family_invites" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "users"("id"),
  "invitee_email" text NOT NULL,
  "relationship_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "token" text NOT NULL UNIQUE,
  "expires_at" text NOT NULL,
  "cancelled_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_family_invite_patient" ON "family_invites" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_family_invite_email" ON "family_invites" ("invitee_email");
CREATE INDEX IF NOT EXISTS "idx_family_invite_status" ON "family_invites" ("status");
CREATE INDEX IF NOT EXISTS "idx_family_invite_token" ON "family_invites" ("token");
