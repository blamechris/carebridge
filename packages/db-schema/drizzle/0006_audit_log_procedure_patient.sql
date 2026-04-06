-- Add procedure_name and patient_id columns to audit_log for HIPAA-compliant audit trails.
-- procedure_name captures the tRPC procedure (e.g. "patients.getById").
-- patient_id links the audit entry directly to a patient record.

ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "procedure_name" text,
  ADD COLUMN IF NOT EXISTS "patient_id" text;

CREATE INDEX IF NOT EXISTS "idx_audit_patient"
  ON "audit_log" ("patient_id", "timestamp");
