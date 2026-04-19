-- Care-team polish: idempotency indexes + role CHECK constraints.
-- Closes issues #881 (idempotency) and #882 (role CHECK parity).
--
--  1. CHECK constraints mirror the Zod enums in
--     `packages/validators/src/care-team.ts`. Zod is the source of truth
--     (app layer); this DB guardrail catches direct SQL writes (seeds,
--     manual fixes, future services) that could otherwise bypass it.
--     The `packages/validators/src/__tests__/care-team.test.ts` tests
--     break if either side drifts.
--
--  2. Partial UNIQUE indexes prevent duplicate ACTIVE rows for a given
--     (patient, provider/user) pair — the DB-level enforcement of the
--     idempotency semantics implemented in services/api-gateway/src/
--     routers/care-team.ts. Soft-deleted rows are retained for HIPAA
--     history and are explicitly excluded from the uniqueness check.
--
-- Non-destructive: existing rows already conform to both sets.

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. CHECK constraints on role columns (#882)
-- ----------------------------------------------------------------------------

ALTER TABLE "care_team_members"
  DROP CONSTRAINT IF EXISTS "care_team_members_role_check";
ALTER TABLE "care_team_members"
  ADD CONSTRAINT "care_team_members_role_check"
  CHECK (role IN ('primary', 'specialist', 'nurse', 'coordinator'));

ALTER TABLE "care_team_assignments"
  DROP CONSTRAINT IF EXISTS "care_team_assignments_role_check";
ALTER TABLE "care_team_assignments"
  ADD CONSTRAINT "care_team_assignments_role_check"
  CHECK (role IN ('attending', 'consulting', 'nursing', 'covering'));

-- ----------------------------------------------------------------------------
-- 2. Partial UNIQUE indexes on active rows (#881)
-- ----------------------------------------------------------------------------

-- Clinical roster: one active row per (provider, patient). Soft-deleted
-- rows (is_active = false) are excluded — we retain them for audit.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_care_team_members_active_unique"
  ON "care_team_members" ("provider_id", "patient_id")
  WHERE is_active = true;

-- RBAC mapping: one active grant per (user, patient). Revoked rows
-- (removed_at IS NOT NULL) are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_care_team_assignments_active_unique"
  ON "care_team_assignments" ("user_id", "patient_id")
  WHERE removed_at IS NULL;

COMMIT;
