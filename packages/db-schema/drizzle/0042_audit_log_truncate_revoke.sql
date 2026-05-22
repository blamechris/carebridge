-- Close the bulk-clearing path that 0012 left open (#995).
--
-- 0012_audit_log_immutability.sql installed BEFORE UPDATE/DELETE row
-- triggers on audit_log to enforce HIPAA §164.312(b) tamper-evidence at
-- the DB level. Two gaps remained:
--
--   1. TRUNCATE bypasses row-level triggers. PostgreSQL fires row-level
--      triggers only per-row on UPDATE/DELETE; TRUNCATE wipes the table
--      without invoking either. A statement-level BEFORE TRUNCATE trigger
--      catches this path.
--
--   2. No REVOKE on UPDATE/DELETE/TRUNCATE — any role granted broad table
--      privileges could still attempt the operation. The trigger catches
--      the attempt but defense-in-depth wants the privilege removed too.
--
-- This migration is additive: the row triggers from 0012 stay in place;
-- we add the TRUNCATE statement trigger and the REVOKE statements.
--
-- Known limitation (not addressed here): the table owner can DROP TRIGGER
-- to bypass enforcement. Mitigation requires running the application as a
-- limited-privilege role distinct from the migration role — operational
-- concern documented in docs/hipaa-retention.md, not enforceable inside a
-- single migration.

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  EXECUTE FUNCTION prevent_audit_log_modification();

REVOKE UPDATE ON audit_log FROM PUBLIC;
REVOKE DELETE ON audit_log FROM PUBLIC;
REVOKE TRUNCATE ON audit_log FROM PUBLIC;
