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
  "0024_flag_dedup_constraint.sql",
);

describe("migration 0024_flag_dedup_constraint", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("adds clinical_flags.rule_id column before referencing it", () => {
    const addColIdx = sql.search(
      /ALTER\s+TABLE\s+clinical_flags\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+rule_id/i,
    );
    const refIdx = sql.search(/idx_flags_open_rule_dedup/);

    assert.ok(
      addColIdx >= 0,
      "migration must contain ADD COLUMN IF NOT EXISTS rule_id",
    );
    assert.ok(refIdx >= 0, "migration must contain partial index using rule_id");
    assert.ok(
      addColIdx < refIdx,
      "ADD COLUMN must come before the partial index that references rule_id",
    );
  });
});
