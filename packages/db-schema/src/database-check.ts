import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type postgres from "postgres";
import { withDatabaseClient, type DatabaseClient } from "./database-client.js";
import { migrationsFolder } from "./database-command.js";
import { DatabaseError, type DatabaseEnvironment } from "./database-config.js";
import * as schema from "./schema/index.js";

const schemaTables = Object.values(schema).flatMap((value) => is(value, PgTable) ? [getTableName(value)] : []);

export function resolveExpectedRole(env: DatabaseEnvironment): string {
  const role = env.DATABASE_EXPECTED_ROLE;
  if (!role?.trim() || role.includes("\0")) throw new DatabaseError("DB_CHECK_ROLE_REQUIRED");
  return role;
}

function readExpectedJournal() {
  try {
    const migrations = readMigrationFiles({ migrationsFolder });
    if (!migrations.length || migrations.some(({ folderMillis }, index) =>
      !Number.isSafeInteger(folderMillis) || folderMillis <= (migrations[index - 1]?.folderMillis ?? 0))) {
      throw new DatabaseError("DB_CHECK_JOURNAL_INVALID");
    }
    return migrations;
  } catch {
    throw new DatabaseError("DB_CHECK_JOURNAL_INVALID");
  }
}

async function readAppliedJournal(sql: postgres.TransactionSql, limit: number) {
  try {
    // Match Drizzle's PostgreSQL journal and bound the result to one extra row.
    return await sql<{ created_at: string; hash: string }[]>`
      select created_at::text, hash
      from drizzle.__drizzle_migrations
      order by created_at
      limit ${limit}
    `;
  } catch {
    throw new DatabaseError("DB_CHECK_JOURNAL_UNAVAILABLE");
  }
}

async function inspectDatabase(sql: postgres.TransactionSql, expectedRole: string) {
  const expected = readExpectedJournal();
  const [identity] = await sql<{ version: number; role_matches: boolean; in_recovery: boolean }[]>`
    select pg_catalog.current_setting('server_version_num')::integer as version,
           current_user::text collate "C" = ${expectedRole} as role_matches,
           pg_catalog.pg_is_in_recovery() as in_recovery
  `;
  if (!identity || identity.version < 160000 || identity.version >= 170000) {
    throw new DatabaseError("DB_CHECK_VERSION_MISMATCH");
  }
  if (!identity.role_matches) throw new DatabaseError("DB_CHECK_ROLE_MISMATCH");
  // The pinned driver's read-write target does not itself reject every hot standby.
  if (identity.in_recovery !== false) throw new DatabaseError("DB_CHECK_NOT_WRITABLE");

  const applied = await readAppliedJournal(sql, expected.length + 1);
  if (applied.length !== expected.length || expected.some(({ folderMillis, hash }, index) =>
    applied[index]?.created_at !== String(folderMillis) || applied[index]?.hash !== hash)) {
    throw new DatabaseError("DB_CHECK_JOURNAL_MISMATCH");
  }

  // Application queries use unqualified names. Check that each resolves to
  // its public table under the runtime role's search path.
  const [tables] = await sql<{ count: number }[]>`
    select count(*)::integer as count
    from pg_catalog.jsonb_array_elements_text(${sql.json(schemaTables)}) as expected(name)
    join pg_catalog.pg_class as relation
      on relation.oid = pg_catalog.to_regclass(pg_catalog.quote_ident(expected.name))
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
  `;
  if (tables?.count !== schemaTables.length) throw new DatabaseError("DB_CHECK_SCHEMA_MISMATCH");
}

export async function checkDatabase(client: DatabaseClient, expectedRole: string, deadlineMs: number): Promise<void> {
  await withDatabaseClient(client, async (sql) => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DatabaseError("DB_CHECK_TIMEOUT")), deadlineMs);
    });
    try {
      await Promise.race([
        sql.begin("isolation level repeatable read read only", (transaction) => inspectDatabase(transaction, expectedRole)),
        deadline,
      ]);
    } catch (cause) {
      if (cause instanceof DatabaseError) throw cause;
      throw new DatabaseError("DB_CHECK_FAILED");
    } finally {
      clearTimeout(timer);
    }
  });
}
