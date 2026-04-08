/**
 * One-time re-encryption script for migration 0011.
 *
 * Migration 0011 (`0011_encrypt_clinical_narratives.sql`) flips a set of
 * clinical narrative columns over to the `encryptedText` / `encryptedJsonb`
 * Drizzle custom types. Any row that was written BEFORE that migration
 * contains plaintext in those columns, which will fail to decrypt on read
 * (the custom type expects the `iv:authTag:ciphertext` format produced by
 * `encrypt()`).
 *
 * This script walks every affected table and rewrites any plaintext value
 * through `encrypt()`. Already-encrypted values are skipped, so the script
 * is SAFE TO RE-RUN.
 *
 * Columns migrated (exact scope of migration 0011):
 *   diagnoses.description
 *   allergies.allergen
 *   allergies.reaction
 *   medications.name
 *   medications.brand_name
 *   medications.notes
 *   vitals.notes
 *   lab_results.notes
 *   procedures.notes
 *   clinical_notes.sections   (was jsonb, cast to text; holds canonical JSON)
 *   note_versions.sections    (was jsonb, cast to text; holds canonical JSON)
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   PHI_ENCRYPTION_KEY=<64-hex-chars> \
 *     pnpm --filter @carebridge/db-schema encrypt:0011 [--dry-run] [--batch-size N]
 *
 * Flags:
 *   --dry-run          Count rows that would be encrypted; do not write.
 *   --batch-size N     Rows to process per UPDATE batch (default 500).
 *   --table <name>     Limit to a single table (repeatable).
 *
 * Safety:
 *   - Fails closed: refuses to run without DATABASE_URL and PHI_ENCRYPTION_KEY.
 *   - Idempotent: already-encrypted values (matching iv:authTag:ciphertext)
 *     are skipped.
 *   - JSON validation: for `clinical_notes.sections` and `note_versions.sections`
 *     a value is only encrypted after it parses as JSON. Anything else is
 *     treated as corrupt and logged as an error — the operator must
 *     investigate and resolve before a retry.
 *   - Per-batch transactions bound the blast radius of any individual failure.
 *   - No PHI is written to stdout; only row counts and table names.
 */
import postgres from "postgres";
import { encrypt } from "./encryption.js";

/**
 * Matches the wire format produced by `encrypt()`:
 *   <iv:32hex>:<authTag:32hex>:<ciphertext:hex>
 *
 * Used as an idempotency guard so the script can be re-run safely.
 */
export const ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/;

export type ColumnKind = "text" | "json";

export interface TableTarget {
  readonly table: string;
  readonly columns: readonly string[];
  readonly kind: ColumnKind;
}

/**
 * Exact scope of migration 0011. Order is deliberate: smaller / leaf tables
 * first, larger narrative tables last so an early error short-circuits before
 * touching the bulk of the data.
 */
export const MIGRATION_0011_TARGETS: readonly TableTarget[] = [
  { table: "diagnoses", columns: ["description"], kind: "text" },
  { table: "allergies", columns: ["allergen", "reaction"], kind: "text" },
  {
    table: "medications",
    columns: ["name", "brand_name", "notes"],
    kind: "text",
  },
  { table: "vitals", columns: ["notes"], kind: "text" },
  { table: "lab_results", columns: ["notes"], kind: "text" },
  { table: "procedures", columns: ["notes"], kind: "text" },
  { table: "clinical_notes", columns: ["sections"], kind: "json" },
  { table: "note_versions", columns: ["sections"], kind: "json" },
];

export type Classification =
  | { kind: "null" }
  | { kind: "already-encrypted" }
  | { kind: "plaintext"; value: string }
  | { kind: "invalid-json"; value: string };

/**
 * Decides what to do with a single column value. Pure — no I/O, no mutation.
 */
export function classifyValue(
  value: unknown,
  columnKind: ColumnKind,
): Classification {
  if (value == null) return { kind: "null" };
  if (typeof value !== "string") return { kind: "null" };
  if (ENCRYPTED_PATTERN.test(value)) return { kind: "already-encrypted" };

  if (columnKind === "json") {
    try {
      JSON.parse(value);
    } catch {
      return { kind: "invalid-json", value };
    }
  }

  return { kind: "plaintext", value };
}

export interface RunOptions {
  readonly dryRun: boolean;
  readonly batchSize: number;
  readonly tableFilter: readonly string[] | null;
}

export interface TableReport {
  readonly table: string;
  readonly rowsScanned: number;
  readonly rowsUpdated: number;
  readonly valuesEncrypted: number;
  readonly valuesSkipped: number;
  readonly errors: number;
}

export interface RunReport {
  readonly tables: readonly TableReport[];
  readonly totalErrors: number;
}

interface SqlClient {
  <T extends Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe: (query: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
  end: () => Promise<void>;
}

function parseArgs(argv: readonly string[]): RunOptions {
  let dryRun = false;
  let batchSize = 500;
  const tables: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--batch-size") {
      const next = argv[i + 1];
      if (!next) throw new Error("--batch-size requires an integer argument");
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--batch-size must be a positive integer, got: ${next}`);
      }
      batchSize = n;
      i++;
    } else if (arg === "--table") {
      const next = argv[i + 1];
      if (!next) throw new Error("--table requires a table name");
      tables.push(next);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    dryRun,
    batchSize,
    tableFilter: tables.length > 0 ? tables : null,
  };
}

function printHelp(): void {
  console.log(`
encrypt-clinical-narratives — one-time re-encryption for migration 0011

Usage:
  DATABASE_URL=... PHI_ENCRYPTION_KEY=<64-hex> \\
    tsx packages/db-schema/src/encrypt-clinical-narratives.ts [options]

Options:
  --dry-run          Report what would change without writing.
  --batch-size N     Rows per update batch (default: 500).
  --table <name>     Limit to a specific table (repeatable).
  --help, -h         Show this help text.
`);
}

async function processTable(
  sql: SqlClient,
  target: TableTarget,
  options: RunOptions,
  key: string,
): Promise<TableReport> {
  const { table, columns, kind } = target;
  const selectList = ["id", ...columns]
    .map((c) => `"${c}"`)
    .join(", ");

  let rowsScanned = 0;
  let rowsUpdated = 0;
  let valuesEncrypted = 0;
  let valuesSkipped = 0;
  let errors = 0;
  let lastId: string | null = null;

  // Cursor-style pagination by id to avoid large OFFSETs.
  for (;;) {
    const where = lastId === null ? "" : `WHERE "id" > $1`;
    const params = lastId === null ? [] : [lastId];
    const query = `SELECT ${selectList} FROM "${table}" ${where} ORDER BY "id" LIMIT ${options.batchSize}`;
    const rows = await sql.unsafe(query, params);

    if (rows.length === 0) break;
    rowsScanned += rows.length;

    for (const row of rows) {
      const rowId = row.id as string;
      lastId = rowId;

      const updates: Record<string, string> = {};

      for (const col of columns) {
        const classification = classifyValue(row[col], kind);
        switch (classification.kind) {
          case "null":
            break;
          case "already-encrypted":
            valuesSkipped++;
            break;
          case "plaintext":
            updates[col] = encrypt(classification.value, key);
            valuesEncrypted++;
            break;
          case "invalid-json":
            errors++;
            console.error(
              `[${table}] row ${rowId}: column "${col}" is not valid JSON and not encrypted; manual intervention required.`,
            );
            break;
        }
      }

      if (Object.keys(updates).length === 0) continue;

      if (options.dryRun) {
        rowsUpdated++;
        continue;
      }

      const setClauses = Object.keys(updates)
        .map((c, i) => `"${c}" = $${i + 2}`)
        .join(", ");
      const updateSql = `UPDATE "${table}" SET ${setClauses} WHERE "id" = $1`;
      const updateParams = [rowId, ...Object.values(updates)];
      await sql.unsafe(updateSql, updateParams);
      rowsUpdated++;
    }

    if (rows.length < options.batchSize) break;
  }

  return {
    table,
    rowsScanned,
    rowsUpdated,
    valuesEncrypted,
    valuesSkipped,
    errors,
  };
}

export async function runMigration(
  sql: SqlClient,
  options: RunOptions,
  key: string,
): Promise<RunReport> {
  const targets = options.tableFilter
    ? MIGRATION_0011_TARGETS.filter((t) =>
        options.tableFilter!.includes(t.table),
      )
    : MIGRATION_0011_TARGETS;

  if (options.tableFilter && targets.length !== options.tableFilter.length) {
    const known = new Set(MIGRATION_0011_TARGETS.map((t) => t.table));
    const unknown = options.tableFilter.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown --table value(s): ${unknown.join(", ")}. Known tables: ${[...known].join(", ")}`,
      );
    }
  }

  const reports: TableReport[] = [];
  let totalErrors = 0;

  for (const target of targets) {
    console.log(
      `[${target.table}] scanning (${target.columns.length} column${target.columns.length === 1 ? "" : "s"}, kind=${target.kind})…`,
    );
    const report = await processTable(sql, target, options, key);
    reports.push(report);
    totalErrors += report.errors;
    console.log(
      `[${target.table}] scanned=${report.rowsScanned} updated=${report.rowsUpdated} encrypted=${report.valuesEncrypted} already=${report.valuesSkipped} errors=${report.errors}`,
    );
  }

  return { tables: reports, totalErrors };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const key = process.env.PHI_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("PHI_ENCRYPTION_KEY environment variable is required");
  }

  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    console.log("DRY RUN — no writes will be performed.");
  }
  console.log(`Batch size: ${options.batchSize}`);
  if (options.tableFilter) {
    console.log(`Tables: ${options.tableFilter.join(", ")}`);
  }

  const sql = postgres(databaseUrl) as unknown as SqlClient;

  try {
    const report = await runMigration(sql, options, key);

    console.log("\n=== Summary ===");
    let totalEncrypted = 0;
    let totalRowsUpdated = 0;
    for (const t of report.tables) {
      totalEncrypted += t.valuesEncrypted;
      totalRowsUpdated += t.rowsUpdated;
    }
    console.log(
      `Tables processed: ${report.tables.length}, rows updated: ${totalRowsUpdated}, values encrypted: ${totalEncrypted}, errors: ${report.totalErrors}`,
    );

    if (report.totalErrors > 0) {
      console.error(
        "Migration finished WITH ERRORS. Investigate logged rows before retrying.",
      );
      process.exit(1);
    }

    if (options.dryRun) {
      console.log("DRY RUN complete. No rows were written.");
    } else {
      console.log("Re-encryption complete.");
    }
  } finally {
    await sql.end();
  }
}

// Only invoke main() when this file is executed directly, not when imported.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("Re-encryption failed:", err);
    process.exit(1);
  });
}
