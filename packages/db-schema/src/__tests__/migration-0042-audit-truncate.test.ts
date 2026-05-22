import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0042_audit_log_truncate_revoke.sql",
);

describe("migration 0042_audit_log_truncate_revoke (#995)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("installs a BEFORE TRUNCATE statement trigger on audit_log", () => {
    // Row-level triggers do NOT fire on TRUNCATE — need a statement-level
    // BEFORE TRUNCATE trigger to close the bulk-clearing path that 0012
    // left open. The trigger must NOT include "FOR EACH ROW" (TRUNCATE
    // is a statement-level operation; PostgreSQL rejects row-level
    // TRUNCATE triggers).
    assert.match(
      sql,
      /CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+TRUNCATE\s+ON\s+audit_log/i,
      "migration must install a BEFORE TRUNCATE trigger on audit_log",
    );
    const truncateBlock = sql.match(
      /CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+TRUNCATE\s+ON\s+audit_log[\s\S]{0,200}?EXECUTE\s+FUNCTION/i,
    );
    assert.ok(truncateBlock, "TRUNCATE trigger must reach EXECUTE FUNCTION");
    assert.doesNotMatch(
      truncateBlock[0],
      /FOR\s+EACH\s+ROW/i,
      "BEFORE TRUNCATE must be statement-level (not FOR EACH ROW)",
    );
  });

  it("revokes UPDATE, DELETE, and TRUNCATE on audit_log from PUBLIC", () => {
    // REVOKE FROM PUBLIC removes the implicit grant the PUBLIC
    // pseudo-role has on new tables in many PostgreSQL configurations.
    // It does NOT affect privileges explicitly granted to named roles —
    // those callers still go through the trigger. Defense-in-depth
    // against accidental future GRANTs to PUBLIC, not a replacement
    // for the trigger.
    assert.match(
      sql,
      /REVOKE\s+[^;]*\bUPDATE\b[^;]*\bON\s+audit_log\b[^;]*\bFROM\s+PUBLIC\b/i,
      "REVOKE UPDATE ... ON audit_log FROM PUBLIC must be present",
    );
    assert.match(
      sql,
      /REVOKE\s+[^;]*\bDELETE\b[^;]*\bON\s+audit_log\b[^;]*\bFROM\s+PUBLIC\b/i,
      "REVOKE DELETE ... ON audit_log FROM PUBLIC must be present",
    );
    assert.match(
      sql,
      /REVOKE\s+[^;]*\bTRUNCATE\b[^;]*\bON\s+audit_log\b[^;]*\bFROM\s+PUBLIC\b/i,
      "REVOKE TRUNCATE ... ON audit_log FROM PUBLIC must be present",
    );
  });

  it("reuses prevent_audit_log_modification() so all three mutation paths share one function", () => {
    // Avoid drift — the new trigger should call the same exception-raising
    // function the row-level triggers use so the function stays the
    // single source of truth.
    assert.match(
      sql,
      /EXECUTE\s+FUNCTION\s+prevent_audit_log_modification\s*\(\s*\)/i,
      "TRUNCATE trigger must call prevent_audit_log_modification()",
    );
  });

  it("redefines prevent_audit_log_modification() to report the actual operation via TG_OP", () => {
    // Under 0012 the function raised "UPDATE/DELETE not permitted",
    // which is misleading when a TRUNCATE attempt fires the new
    // statement trigger. CREATE OR REPLACE FUNCTION with TG_OP makes
    // the message accurate for every trigger that calls it.
    assert.match(
      sql,
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+prevent_audit_log_modification/i,
      "migration must CREATE OR REPLACE the function so the new message is in effect",
    );
    // Body must contain both RAISE EXCEPTION and TG_OP — splitting into
    // two checks avoids a regex that has to span the `;` inside the
    // exception-message string literal.
    assert.match(sql, /RAISE\s+EXCEPTION/i, "function body must RAISE EXCEPTION");
    assert.match(
      sql,
      /TG_OP/,
      "function body must reference TG_OP so the error message names the actual operation",
    );
  });
});
