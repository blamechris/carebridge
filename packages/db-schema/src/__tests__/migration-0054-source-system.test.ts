import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { encounters, diagnoses, allergies } from "../schema/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0054_source_system_columns.sql",
);

describe("migration 0054_source_system_columns (#1190)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("adds source_system NOT NULL DEFAULT 'internal' to encounters", () => {
    // Pure additive ADD COLUMN — the DEFAULT 'internal' populates every
    // existing row in the same statement, so no NOT VALID + VALIDATE
    // dance is required (Pattern A from docs/migration-patterns.md
    // without the pre-clean step because the default IS the cleanup).
    assert.match(
      sql,
      /ALTER\s+TABLE\s+encounters\s+ADD\s+COLUMN\s+source_system\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'internal'/i,
      "migration must add source_system NOT NULL DEFAULT 'internal' to encounters",
    );
  });

  it("adds source_system NOT NULL DEFAULT 'internal' to diagnoses", () => {
    assert.match(
      sql,
      /ALTER\s+TABLE\s+diagnoses\s+ADD\s+COLUMN\s+source_system\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'internal'/i,
      "migration must add source_system NOT NULL DEFAULT 'internal' to diagnoses",
    );
  });

  it("adds source_system NOT NULL DEFAULT 'internal' to allergies", () => {
    assert.match(
      sql,
      /ALTER\s+TABLE\s+allergies\s+ADD\s+COLUMN\s+source_system\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'internal'/i,
      "migration must add source_system NOT NULL DEFAULT 'internal' to allergies",
    );
  });

  it("does not touch any other tables (single-purpose migration)", () => {
    // Defends against accidental scope creep — the migration must only
    // alter the three tables documented in the PR. ALTER TABLE statements
    // for any other table should fail this check.
    const alterMatches = Array.from(
      sql.matchAll(/ALTER\s+TABLE\s+(\w+)/gi),
      (m) => m[1].toLowerCase(),
    );
    const allowed = new Set(["encounters", "diagnoses", "allergies"]);
    const unexpected = alterMatches.filter((t) => !allowed.has(t));
    assert.deepEqual(
      unexpected,
      [],
      `migration must only ALTER encounters/diagnoses/allergies; got ${unexpected.join(", ")}`,
    );
  });
});

describe("drizzle schema source_system columns (#1190)", () => {
  // The Drizzle column descriptor exposes `default` and `notNull` so we
  // can verify the schema definition matches the migration SQL without
  // spinning up Postgres. Catches drift where the SQL adds the column
  // but the TS schema forgets it (or vice versa).

  it("encounters.source_system is NOT NULL with default 'internal'", () => {
    const cols = getTableColumns(encounters);
    const col = cols.source_system;
    assert.ok(col, "encounters schema must define source_system column");
    assert.equal(col.notNull, true, "encounters.source_system must be NOT NULL");
    assert.equal(
      col.default,
      "internal",
      "encounters.source_system must default to 'internal'",
    );
  });

  it("diagnoses.source_system is NOT NULL with default 'internal'", () => {
    const cols = getTableColumns(diagnoses);
    const col = cols.source_system;
    assert.ok(col, "diagnoses schema must define source_system column");
    assert.equal(col.notNull, true, "diagnoses.source_system must be NOT NULL");
    assert.equal(
      col.default,
      "internal",
      "diagnoses.source_system must default to 'internal'",
    );
  });

  it("allergies.source_system is NOT NULL with default 'internal'", () => {
    const cols = getTableColumns(allergies);
    const col = cols.source_system;
    assert.ok(col, "allergies schema must define source_system column");
    assert.equal(col.notNull, true, "allergies.source_system must be NOT NULL");
    assert.equal(
      col.default,
      "internal",
      "allergies.source_system must default to 'internal'",
    );
  });

  it("encounters.source_system preserves explicit 'epic' overrides at the type level", () => {
    // Drizzle text() with .default() still allows the caller to pass an
    // explicit value on insert — the default only applies when the field
    // is absent. This isn't an exhaustive runtime check (no DB connection
    // here) but verifies the column is a plain text column, not an enum
    // that would reject 'epic'.
    const cols = getTableColumns(encounters);
    const col = cols.source_system;
    assert.equal(col.dataType, "string");
    assert.equal(col.columnType, "PgText");
  });
});
