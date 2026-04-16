-- Populate actor identity context in the audit trail.
--
-- HIPAA § 164.312(b) audit controls must distinguish the actor's relationship
-- to the subject of the record. Family caregivers acting on behalf of a
-- patient were previously indistinguishable from patients acting on their
-- own records. See issue #309.
--
-- actor_relationship values:
--   'self'                   — patient acting on their own record
--   'spouse','parent','child','sibling','healthcare_poa','other'
--                            — family caregiver acting on a patient (mirrors
--                              family_relationships.relationship_type)
--   NULL                     — clinician/admin (no relationship semantics)
--
-- on_behalf_of_patient_id is populated for family-caregiver actions only so
-- that revocation audits can reconstruct which patient was affected.

ALTER TABLE "audit_log" ADD COLUMN "actor_relationship" text;
ALTER TABLE "audit_log" ADD COLUMN "on_behalf_of_patient_id" text;

CREATE INDEX "idx_audit_actor_relationship"
  ON "audit_log" ("actor_relationship", "timestamp");
CREATE INDEX "idx_audit_on_behalf_of"
  ON "audit_log" ("on_behalf_of_patient_id", "timestamp");
