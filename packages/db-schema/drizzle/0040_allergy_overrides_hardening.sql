-- Harden the allergy_overrides audit trail (#905, #906).
--
-- Two related changes rolled into one non-destructive migration:
--
-- 1. Denormalise the allergen / medication strings that the override
--    pertains to (issue #905).
--
--    Prior to this change, the ai-oversight rule layer recovered those
--    strings by regex-parsing `clinical_flags.summary` — which is fragile
--    (summary wording is a UX concern, not a schema contract) and couples
--    the rule-layer suppression decision to the exact phrasing of the
--    flag's human-readable message. Persisting the allergen and medication
--    as explicit columns lets the suppression query read them directly,
--    decouples the rule layer from the flag-summary text, and gives HIPAA
--    reviewers a queryable field rather than a substring match.
--
--    Both columns are nullable to preserve backward compatibility for
--    rows written prior to this migration; the rule layer falls back to
--    the legacy parsing-from-summary path when either column is NULL,
--    and the suppression tests cover both legacy and denormalised rows.
--
-- 2. Enforce immutability at the database level (issue #906).
--
--    The application layer already treats allergy_overrides as permanent —
--    `allergies.override` only ever INSERTs rows — but there was no
--    database-level safety net. Following the precedent in
--    0012_audit_log_immutability.sql, we install BEFORE UPDATE / BEFORE
--    DELETE triggers that raise an exception. This closes the residual
--    risk that a future code path (or a misconfigured admin migration)
--    could mutate or delete override records, which would undermine the
--    audit-trail guarantee the table exists to provide.
--
--    Triggers are used instead of a REVOKE of table privileges so the
--    constraint travels with the schema and does not depend on how roles
--    are provisioned in each deployment.

-- (1) Denormalised allergen / medication strings (nullable for backfill).
ALTER TABLE "allergy_overrides"
  ADD COLUMN IF NOT EXISTS "medication_name" text,
  ADD COLUMN IF NOT EXISTS "allergen_name" text;

-- (2) Append-only immutability (trigger-based, mirrors 0012_audit_log_*).
CREATE OR REPLACE FUNCTION prevent_allergy_override_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'allergy_overrides is append-only; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS allergy_overrides_no_update ON "allergy_overrides";
CREATE TRIGGER allergy_overrides_no_update
  BEFORE UPDATE ON "allergy_overrides"
  FOR EACH ROW EXECUTE FUNCTION prevent_allergy_override_modification();

DROP TRIGGER IF EXISTS allergy_overrides_no_delete ON "allergy_overrides";
CREATE TRIGGER allergy_overrides_no_delete
  BEFORE DELETE ON "allergy_overrides"
  FOR EACH ROW EXECUTE FUNCTION prevent_allergy_override_modification();
