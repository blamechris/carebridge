-- Harden the family-access tables added in 0025_family_access.sql.
-- Closes issue #311.
--
--  1. Add a granular access_scopes JSONB column (array of permission tokens)
--     to both tables so scopes can be queried at the database level instead
--     of carrying fragile comma-delimited text.
--  2. Add CHECK constraints on enum-like columns (relationship_type, status).
--  3. Add a partial UNIQUE index preventing duplicate active relationships
--     for the same (patient_id, caregiver_id) pair. Revoked rows are
--     retained for audit and are excluded from the uniqueness check.
--  4. Switch the existing foreign keys to ON DELETE CASCADE so that deleting
--     a user does not leave orphaned relationship / invite rows.

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. access_scopes column (JSONB array)
-- ----------------------------------------------------------------------------

ALTER TABLE "family_relationships"
  ADD COLUMN IF NOT EXISTS "access_scopes" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "family_invites"
  ADD COLUMN IF NOT EXISTS "access_scopes" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- 2. CHECK constraints on enum-like text columns
-- ----------------------------------------------------------------------------

ALTER TABLE "family_relationships"
  DROP CONSTRAINT IF EXISTS "family_rel_relationship_type_check";
ALTER TABLE "family_relationships"
  ADD CONSTRAINT "family_rel_relationship_type_check"
  CHECK (relationship_type IN ('spouse','parent','child','sibling','healthcare_poa','other'));

ALTER TABLE "family_relationships"
  DROP CONSTRAINT IF EXISTS "family_rel_status_check";
ALTER TABLE "family_relationships"
  ADD CONSTRAINT "family_rel_status_check"
  CHECK (status IN ('active','revoked'));

ALTER TABLE "family_relationships"
  DROP CONSTRAINT IF EXISTS "family_rel_access_scopes_is_array";
ALTER TABLE "family_relationships"
  ADD CONSTRAINT "family_rel_access_scopes_is_array"
  CHECK (jsonb_typeof(access_scopes) = 'array');

ALTER TABLE "family_invites"
  DROP CONSTRAINT IF EXISTS "family_invite_relationship_type_check";
ALTER TABLE "family_invites"
  ADD CONSTRAINT "family_invite_relationship_type_check"
  CHECK (relationship_type IN ('spouse','parent','child','sibling','healthcare_poa','other'));

ALTER TABLE "family_invites"
  DROP CONSTRAINT IF EXISTS "family_invite_status_check";
ALTER TABLE "family_invites"
  ADD CONSTRAINT "family_invite_status_check"
  CHECK (status IN ('pending','accepted','cancelled','expired'));

ALTER TABLE "family_invites"
  DROP CONSTRAINT IF EXISTS "family_invite_access_scopes_is_array";
ALTER TABLE "family_invites"
  ADD CONSTRAINT "family_invite_access_scopes_is_array"
  CHECK (jsonb_typeof(access_scopes) = 'array');

-- ----------------------------------------------------------------------------
-- 3. Partial UNIQUE index on active relationships
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "idx_family_rel_active_unique"
  ON "family_relationships" ("patient_id", "caregiver_id")
  WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- 4. ON DELETE CASCADE on foreign keys
-- ----------------------------------------------------------------------------

-- family_relationships.patient_id -> users.id
ALTER TABLE "family_relationships"
  DROP CONSTRAINT IF EXISTS "family_relationships_patient_id_users_id_fk";
ALTER TABLE "family_relationships"
  ADD CONSTRAINT "family_relationships_patient_id_users_id_fk"
  FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- family_relationships.caregiver_id -> users.id
ALTER TABLE "family_relationships"
  DROP CONSTRAINT IF EXISTS "family_relationships_caregiver_id_users_id_fk";
ALTER TABLE "family_relationships"
  ADD CONSTRAINT "family_relationships_caregiver_id_users_id_fk"
  FOREIGN KEY ("caregiver_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- family_invites.patient_id -> users.id
ALTER TABLE "family_invites"
  DROP CONSTRAINT IF EXISTS "family_invites_patient_id_users_id_fk";
ALTER TABLE "family_invites"
  ADD CONSTRAINT "family_invites_patient_id_users_id_fk"
  FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE;

COMMIT;
