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
  "0055_fingerprint_dedup_indexes.sql",
);

/**
 * Migration 0055 adds composite indexes covering the cross-source
 * fingerprint dedup lookups added in #1197 / #1191. The fingerprint
 * queries live in services/epic-connector/src/sync/persistence.ts and
 * are shaped as:
 *
 *   WHERE patient_id = $1 AND <coded-dim> = $2 [AND <temporal> = $3]
 *
 * Each index must exist on the right (table, columns) tuple AND carry
 * the partial-index WHERE clause where specified (so the index covers
 * only rows the fingerprint query actually targets). This test
 * introspects the SQL to defend against accidental renames /
 * column-order swaps / WHERE-clause regression.
 */
describe("migration 0055_fingerprint_dedup_indexes (#1204)", () => {
  const rawSql = readFileSync(MIGRATION_PATH, "utf8");
  // Strip `-- ...` line comments so introspection assertions (CONCURRENTLY,
  // ALTER TABLE, CREATE INDEX counts) don't false-positive on prose in the
  // migration header. We still keep `rawSql` around for assertions that
  // should match the file as written (e.g. specific index definitions —
  // those won't appear inside comments).
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
      name: "idx_encounters_dedup",
      table: "encounters",
      columns: ["patient_id", "start_time", "encounter_type"],
    },
    {
      name: "idx_diagnoses_dedup_icd10",
      table: "diagnoses",
      columns: ["patient_id", "icd10_code"],
      where: "icd10_code",
    },
    {
      name: "idx_diagnoses_dedup_snomed",
      table: "diagnoses",
      columns: ["patient_id", "snomed_code"],
      where: "snomed_code",
    },
    {
      name: "idx_allergies_dedup_rxnorm",
      table: "allergies",
      columns: ["patient_id", "rxnorm_code"],
      where: "rxnorm_code",
    },
    {
      name: "idx_allergies_dedup_snomed",
      table: "allergies",
      columns: ["patient_id", "snomed_code"],
      where: "snomed_code",
    },
    {
      name: "idx_medications_dedup",
      table: "medications",
      columns: ["patient_id", "rxnorm_code", "started_at"],
      where: "rxnorm_code",
    },
    {
      name: "idx_vitals_dedup",
      table: "vitals",
      columns: ["patient_id", "loinc_code", "recorded_at"],
      where: "loinc_code",
    },
  ];

  for (const spec of expected) {
    it(`creates ${spec.name} on ${spec.table}(${spec.columns.join(", ")})${
      spec.where ? ` WHERE ${spec.where} IS NOT NULL` : ""
    }`, () => {
      // The column list is allowed to carry per-column quoting and
      // arbitrary whitespace between tokens but must appear in the
      // exact declared order. Stitching the regex together with
      // \s*,\s* between columns keeps formatting-tolerance while
      // pinning order.
      const columnPattern = spec.columns
        .map((c) => `"?${c}"?`)
        .join("\\s*,\\s*");
      const tableExpr = `"?${spec.table}"?`;
      const namePattern = `"?${spec.name}"?`;

      // CREATE INDEX [IF NOT EXISTS] <name> ON <table> [USING btree]
      // (<columns>) [WHERE <col> IS NOT NULL]
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

  it("uses CREATE INDEX IF NOT EXISTS for every index (idempotent reruns)", () => {
    // Repo convention: all migration-added indexes use IF NOT EXISTS so
    // a re-run on a partially-applied DB doesn't blow up. Catches a
    // drop-and-forget regression where someone removes the guard.
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
    // Mirrors the rationale documented in 0034_gin_trigger_event_ids.sql:
    // PostgreSQL forbids CREATE INDEX CONCURRENTLY inside a transaction,
    // and Drizzle's migrator wraps each .sql file in one. Operators run
    // CONCURRENTLY out-of-band when the table is hot.
    assert.doesNotMatch(
      sql,
      /CONCURRENTLY/i,
      "migration must not use CONCURRENTLY — Drizzle runs migrations in a transaction",
    );
  });

  it("does not ALTER any tables (additive index-only migration)", () => {
    // Defends against scope creep — this PR is index-only.
    assert.doesNotMatch(
      sql,
      /ALTER\s+TABLE/i,
      "migration must be index-only; no ALTER TABLE statements allowed",
    );
  });
});
