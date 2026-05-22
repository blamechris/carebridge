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
--   2. PUBLIC privileges. The PUBLIC pseudo-role is granted privileges
--      by default on newly-created tables in many PostgreSQL configs.
--      Revoking UPDATE/DELETE/TRUNCATE from PUBLIC removes the implicit
--      grant; the trigger still catches any role that has been
--      explicitly granted those privileges. This is defense-in-depth
--      against accidental future GRANTs to PUBLIC, not a substitute for
--      the trigger.
--
-- This migration is additive: the row triggers from 0012 stay in place;
-- we add the TRUNCATE statement trigger and the REVOKE-from-PUBLIC
-- statements. The shared trigger function is redefined so its error
-- message reports the actual operation (UPDATE / DELETE / TRUNCATE) via
-- the TG_OP special variable — under the old definition a TRUNCATE
-- attempt raised "UPDATE/DELETE not permitted" which misled debuggers.
--
-- Known limitation (not addressed here): the table owner can DROP TRIGGER
-- to bypass enforcement. Mitigation requires running the application as a
-- limited-privilege role distinct from the migration role — operational
-- concern documented in docs/hipaa-retention.md, not enforceable inside a
-- single migration.

CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  EXECUTE FUNCTION prevent_audit_log_modification();

REVOKE UPDATE ON audit_log FROM PUBLIC;
REVOKE DELETE ON audit_log FROM PUBLIC;
REVOKE TRUNCATE ON audit_log FROM PUBLIC;
