-- Prevent duplicate active family access relationships (issue #308).
--
-- Without this constraint, concurrent accept-invite transactions (or a
-- patient re-inviting a caregiver who already has access) could create
-- multiple active rows for the same (patient_id, caregiver_id) pair.
-- Revoking one row would leave the others active, silently retaining
-- access the patient believed was gone.
--
-- Partial index: only active (non-revoked) rows are unique-constrained,
-- so a caregiver whose access was revoked can later be re-invited.

CREATE UNIQUE INDEX IF NOT EXISTS idx_family_rel_active_unique
  ON family_relationships (patient_id, caregiver_id)
  WHERE revoked_at IS NULL;
