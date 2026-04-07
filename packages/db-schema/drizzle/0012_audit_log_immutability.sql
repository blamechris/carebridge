-- Make audit_log append-only for HIPAA compliance.
-- HIPAA requires tamper-protection of audit trails; we enforce this at the
-- database level via triggers that reject any UPDATE or DELETE.

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; UPDATE/DELETE not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
