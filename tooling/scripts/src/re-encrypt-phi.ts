/**
 * Re-encrypt every PHI column under the current `PHI_ENCRYPTION_KEY`.
 *
 * Intended to be run once during a key rotation after the new key has been
 * rolled out with the old key set as `PHI_ENCRYPTION_KEY_PREVIOUS`. See
 * docs/phi-key-rotation.md.
 *
 * Strategy:
 *   Bulk migration — bypass the Drizzle custom type and work on raw
 *   ciphertext. For every (table, column) pair listed below the script
 *   reads the stored ciphertext directly, tries `decrypt` with the
 *   current key first (to skip already-migrated rows), falls back to the
 *   previous key, and writes the re-encrypted value back under the
 *   current key. The two-step try/catch is what lets the script be
 *   idempotent.
 *
 *   Pagination is keyset (WHERE id > $lastId) rather than LIMIT/OFFSET so
 *   the runtime stays linear on large tables.
 *
 * Usage:
 *   pnpm --filter @carebridge/scripts tsx src/re-encrypt-phi.ts --dry-run
 *   pnpm --filter @carebridge/scripts tsx src/re-encrypt-phi.ts
 *   pnpm --filter @carebridge/scripts tsx src/re-encrypt-phi.ts --table=patients --batch-size=200
 *
 * Safety:
 *   - Idempotent: re-running is a no-op on rows already under the new key.
 *   - No table drops, no schema changes.
 *   - Fails loudly if `PHI_ENCRYPTION_KEY_PREVIOUS` is unset (nothing to
 *     migrate from) or if a row cannot be decrypted under either key.
 *   - JSONB columns are validated as JSON after decrypt so a schema/list
 *     mismatch is caught before a round-trip writes garbage.
 */

import postgres from "postgres";
import {
  encrypt,
  getKey,
  getPreviousKey,
  decryptWithFallback,
} from "@carebridge/db-schema";

interface EncryptedColumn {
  table: string;
  column: string;
  /**
   * True for encryptedJsonb columns — after decrypt the plaintext is a JSON
   * document. The script validates it with JSON.parse so a wrong column
   * mapping surfaces before we re-encrypt garbage.
   */
  jsonb?: boolean;
}

/**
 * Enumerated from grep across packages/db-schema/src/schema. Table names
 * are the actual pgTable names, NOT the Drizzle constant names. If a
 * schema adds a new encrypted column, update this list — there is no
 * runtime reflection of Drizzle custom types that would let us discover
 * them. A drift check lives in the integration tests; run
 *   pnpm --filter @carebridge/scripts test
 * after editing this list.
 */
const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  // packages/db-schema/src/schema/auth.ts
  { table: "users", column: "mfa_secret" },

  // packages/db-schema/src/schema/patients.ts
  { table: "patients", column: "name" },
  { table: "patients", column: "date_of_birth" },
  { table: "patients", column: "diagnosis" },
  { table: "patients", column: "notes" },
  { table: "patients", column: "mrn" },
  { table: "patients", column: "insurance_id" },
  { table: "patients", column: "emergency_contact_name" },
  { table: "patients", column: "emergency_contact_phone" },
  { table: "diagnoses", column: "description" },
  { table: "allergies", column: "allergen" },
  { table: "allergies", column: "reaction" },

  // packages/db-schema/src/schema/patient-observations.ts
  { table: "patient_observations", column: "description" },

  // packages/db-schema/src/schema/notifications.ts
  { table: "notifications", column: "title" },
  { table: "notifications", column: "body" },

  // packages/db-schema/src/schema/scheduling.ts — the encrypted column lives
  // on the appointments table, not a 'scheduling' table.
  { table: "appointments", column: "notes" },

  // packages/db-schema/src/schema/emergency-access.ts
  { table: "emergency_access", column: "justification" },

  // packages/db-schema/src/schema/encounters.ts
  { table: "encounters", column: "notes" },

  // packages/db-schema/src/schema/notes.ts — JSONB sections on BOTH the
  // primary note row and every immutable version snapshot.
  { table: "clinical_notes", column: "sections", jsonb: true },
  { table: "note_versions", column: "sections", jsonb: true },

  // packages/db-schema/src/schema/messaging.ts
  { table: "messages", column: "body" },

  // packages/db-schema/src/schema/clinical-data.ts
  { table: "medications", column: "name" },
  { table: "medications", column: "brand_name" },
  { table: "medications", column: "notes" },
  { table: "vitals", column: "notes" },
  { table: "vitals", column: "value_primary" },
  { table: "vitals", column: "value_secondary" },
  { table: "lab_results", column: "notes" },
  { table: "lab_results", column: "value" },
  { table: "lab_results", column: "reference_low" },
  { table: "lab_results", column: "reference_high" },
  { table: "lab_results", column: "flag" },
  { table: "procedures", column: "notes" },
  { table: "events", column: "title" },
  { table: "events", column: "body" },
];

interface Options {
  dryRun: boolean;
  batchSize: number;
  tableFilter: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, batchSize: 500, tableFilter: null };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--batch-size=")) {
      opts.batchSize = Number(arg.split("=")[1]);
      if (!Number.isFinite(opts.batchSize) || opts.batchSize < 1) {
        throw new Error("--batch-size must be a positive integer");
      }
    } else if (arg.startsWith("--table=")) {
      opts.tableFilter = arg.split("=")[1] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: re-encrypt-phi.ts [--dry-run] [--batch-size=500] [--table=<name>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function reencryptTableColumn(
  sql: postgres.Sql,
  col: EncryptedColumn,
  opts: Options,
): Promise<{ total: number; rewritten: number; skipped: number }> {
  const currentKey = getKey();
  const previousKey = getPreviousKey();
  if (!previousKey) {
    throw new Error(
      "PHI_ENCRYPTION_KEY_PREVIOUS is not set. Nothing to migrate from — " +
        "either you have already removed the previous key, or no rotation is in progress.",
    );
  }

  let rewritten = 0;
  let skipped = 0;
  let total = 0;

  // Keyset pagination: walk the (ordered by id) stream without OFFSET, so
  // runtime is linear even on tables with millions of rows.
  let lastId: string | null = null;

  for (;;) {
    const query = lastId === null
      ? `SELECT id, "${col.column}" AS value FROM "${col.table}"
         WHERE "${col.column}" IS NOT NULL
         ORDER BY id
         LIMIT ${opts.batchSize}`
      : `SELECT id, "${col.column}" AS value FROM "${col.table}"
         WHERE "${col.column}" IS NOT NULL
           AND id > $1
         ORDER BY id
         LIMIT ${opts.batchSize}`;

    const rows = (lastId === null
      ? await sql.unsafe(query)
      : await sql.unsafe(query, [lastId])) as Array<{
      id: string;
      value: string;
    }>;
    if (rows.length === 0) break;
    total += rows.length;

    for (const row of rows) {
      // Try decrypting under the current key first. If that succeeds we
      // know the row is already under the new key and we can skip it
      // without touching it.
      let plaintext: string;
      try {
        decryptWithFallback(row.value, currentKey, null);
        skipped += 1;
        continue;
      } catch {
        // Not under current key — fall through to try the previous key.
      }

      try {
        plaintext = decryptWithFallback(row.value, previousKey, null);
      } catch (err) {
        throw new Error(
          `Row ${col.table}.${col.column} id=${row.id} failed to decrypt under both keys: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Validate JSONB plaintext is well-formed JSON before re-encrypting.
      // Catches schema/list mismatches (e.g. marking a text column as jsonb)
      // before we silently rewrite garbage.
      if (col.jsonb) {
        try {
          JSON.parse(plaintext);
        } catch (err) {
          throw new Error(
            `Row ${col.table}.${col.column} id=${row.id} decrypted to invalid JSON — ` +
              `column-list may be wrong. Details: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
      }

      const reencrypted = encrypt(plaintext, currentKey);
      if (!opts.dryRun) {
        await sql.unsafe(
          `UPDATE "${col.table}" SET "${col.column}" = $1 WHERE id = $2`,
          [reencrypted, row.id],
        );
      }
      rewritten += 1;
    }

    lastId = rows[rows.length - 1]!.id;
  }

  return { total, rewritten, skipped };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const sql = postgres(dbUrl, { max: 4 });

  const cols = opts.tableFilter
    ? ENCRYPTED_COLUMNS.filter((c) => c.table === opts.tableFilter)
    : ENCRYPTED_COLUMNS;
  if (cols.length === 0) {
    console.error(`No encrypted columns found for table=${opts.tableFilter}`);
    await sql.end();
    process.exit(1);
  }

  console.log(
    `Re-encrypt PHI — ${opts.dryRun ? "DRY RUN" : "LIVE"}, batch=${opts.batchSize}, tables=${cols.length}`,
  );

  let totalRewritten = 0;
  let totalSkipped = 0;

  for (const col of cols) {
    process.stdout.write(`  ${col.table}.${col.column} ... `);
    try {
      const stats = await reencryptTableColumn(sql, col, opts);
      totalRewritten += stats.rewritten;
      totalSkipped += stats.skipped;
      console.log(
        `read ${stats.total}, rewrite ${stats.rewritten}, skip ${stats.skipped}`,
      );
    } catch (err) {
      // Missing tables are fine — the enumerated list is conservative.
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .* does not exist/.test(msg)) {
        console.log("skip (table missing)");
        continue;
      }
      console.log(`FAILED — ${msg}`);
      await sql.end();
      process.exit(1);
    }
  }

  await sql.end();

  console.log("");
  console.log(
    `Summary: rewrote ${totalRewritten} row(s), skipped ${totalSkipped} already-current row(s).`,
  );
  if (totalRewritten === 0 && !opts.dryRun) {
    console.log(
      "No rows needed rewriting — you can now unset PHI_ENCRYPTION_KEY_PREVIOUS.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
