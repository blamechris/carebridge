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
    // REVOKE is the second defense layer — even if a future migration
    // misses the trigger or a role is granted broad permissions, the
    // explicit REVOKE keeps the mutation paths closed by default.
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

  it("reuses the existing prevent_audit_log_modification() function from 0012", () => {
    // Avoid drift — the new trigger should call the same exception-raising
    // function the row-level triggers use, so all three mutation paths
    // produce the same error message.
    assert.match(
      sql,
      /EXECUTE\s+FUNCTION\s+prevent_audit_log_modification\s*\(\s*\)/i,
      "TRUNCATE trigger must call prevent_audit_log_modification() to match 0012's row triggers",
    );
  });
});
