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
  "0056_diagnoses_dedup_indexes_with_onset.sql",
);

/**
 * Migration 0056 extends the two diagnoses dedup indexes added in 0055
 * (#1204) so they include `onset_date` as the trailing column — mirroring
 * the shape used by `idx_medications_dedup(patient_id, rxnorm_code,
 * started_at)` and `idx_vitals_dedup(patient_id, loinc_code,
 * recorded_at)`.
 *
 * The full fingerprint predicate in
 * services/epic-connector/src/sync/persistence.ts is shaped as:
 *
 *   WHERE patient_id = $1 AND <coded-dim> = $2 [AND onset_date = $3]
 *
 * The three-column shape lets the planner satisfy the full predicate
 * from the index alone when onsetDate is supplied, and is still
 * prefix-scannable for the two-column predicate.
 *
 * This test introspects the SQL to defend against accidental
 * renames / column-order swaps / WHERE-clause regression / missing
 * DROPs for the 0055 variants.
 */
describe("migration 0056_diagnoses_dedup_indexes_with_onset (#1211)", () => {
  const rawSql = readFileSync(MIGRATION_PATH, "utf8");
  // Strip `-- ...` line comments so introspection assertions don't
  // false-positive on prose in the migration header.
  const sql = rawSql.replace(/--[^\n]*/g, "");

  type IndexSpec = {
    name: string;
    table: string;
    columns: readonly string[];
    /** When present, the index must carry this partial WHERE clause. */
    where?: string;
  };

  const expected: readonly IndexSpec[] = [
    {
      name: "idx_diagnoses_dedup_icd10",
      table: "diagnoses",
      columns: ["patient_id", "icd10_code", "onset_date"],
      where: "icd10_code",
    },
    {
      name: "idx_diagnoses_dedup_snomed",
      table: "diagnoses",
      columns: ["patient_id", "snomed_code", "onset_date"],
      where: "snomed_code",
    },
  ];

  for (const spec of expected) {
    it(`creates ${spec.name} on ${spec.table}(${spec.columns.join(", ")})${
      spec.where ? ` WHERE ${spec.where} IS NOT NULL` : ""
    }`, () => {
      const columnPattern = spec.columns
        .map((c) => `"?${c}"?`)
        .join("\\s*,\\s*");
      const tableExpr = `"?${spec.table}"?`;
      const namePattern = `"?${spec.name}"?`;
      const wherePattern = spec.where
        ? `\\s+WHERE\\s+"?${spec.where}"?\\s+IS\\s+NOT\\s+NULL`
        : "";
      const re = new RegExp(
        `CREATE\\s+INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${namePattern}\\s+ON\\s+${tableExpr}(\\s+USING\\s+btree)?\\s*\\(\\s*${columnPattern}\\s*\\)${wherePattern}`,
        "i",
      );

      assert.match(
        sql,
        re,
        `migration must create ${spec.name} on ${spec.table}(${spec.columns.join(
          ", ",
        )})${spec.where ? ` WHERE ${spec.where} IS NOT NULL` : ""}`,
      );
    });
  }

  it("drops the 0055 two-column variants before recreating them", () => {
    // The two diagnoses dedup indexes from 0055 must be dropped first,
    // otherwise PostgreSQL keeps the narrower index and CREATE INDEX
    // IF NOT EXISTS becomes a no-op.
    for (const name of [
      "idx_diagnoses_dedup_icd10",
      "idx_diagnoses_dedup_snomed",
    ]) {
      const re = new RegExp(
        `DROP\\s+INDEX\\s+(IF\\s+EXISTS\\s+)?"?${name}"?`,
        "i",
      );
      assert.match(
        sql,
        re,
        `migration must DROP INDEX IF EXISTS ${name} before recreating`,
      );
    }
  });

  it("uses CREATE INDEX IF NOT EXISTS for every index (idempotent reruns)", () => {
    const createIndexStmts = sql.match(/CREATE\s+INDEX\s+[^\n]*/gi) ?? [];
    assert.equal(
      createIndexStmts.length,
      expected.length,
      `expected ${expected.length} CREATE INDEX statements, found ${createIndexStmts.length}`,
    );
    for (const stmt of createIndexStmts) {
      assert.match(
        stmt,
        /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i,
        `every CREATE INDEX must use IF NOT EXISTS, got: ${stmt}`,
      );
    }
  });

  it("does not use CONCURRENTLY (Drizzle wraps migrations in a transaction)", () => {
    // Mirrors 0055/0034 rationale: PostgreSQL forbids CREATE INDEX
    // CONCURRENTLY inside a transaction, and Drizzle's migrator wraps
    // each .sql file in one.
    assert.doesNotMatch(
      sql,
      /CONCURRENTLY/i,
      "migration must not use CONCURRENTLY — Drizzle runs migrations in a transaction",
    );
  });

  it("does not ALTER any tables (additive index-only migration)", () => {
    assert.doesNotMatch(
      sql,
      /ALTER\s+TABLE/i,
      "migration must be index-only; no ALTER TABLE statements allowed",
    );
  });
});
