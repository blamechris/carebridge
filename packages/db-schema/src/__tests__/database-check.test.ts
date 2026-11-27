import assert from "node:assert/strict";
import test from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { DatabaseClient } from "../database-client.js";
import { checkDatabase, resolveExpectedRole } from "../database-check.js";
import { migrationsFolder } from "../database-command.js";

const validIdentity = { version: 160011, role_matches: true, in_recovery: false };
const validJournal = readMigrationFiles({ migrationsFolder }).map(({ folderMillis, hash }) => ({
  created_at: String(folderMillis),
  hash,
}));

type Read = (values: unknown[]) => unknown;

function connection(reads: Read[]) {
  let closeCount = 0;
  const queries: string[] = [];
  const transaction = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join("?").trim());
    const read = reads.shift();
    if (!read) assert.fail("unexpected metadata query");
    return read(values);
  }, { json: (value: unknown) => value });
  const client: DatabaseClient = {
    sql: {
      begin: async (options: string, check: (sql: typeof transaction) => Promise<unknown>) => {
        assert.equal(options, "isolation level repeatable read read only");
        return check(transaction);
      },
    } as unknown as DatabaseClient["sql"],
    close: async () => { closeCount += 1; },
  };
  return { client, queries, closeCount: () => closeCount };
}

test("preflight reads only bound role and schema metadata and closes after success", async () => {
  const role = resolveExpectedRole(Object.freeze({ DATABASE_EXPECTED_ROLE: "fixture_runtime" }));
  const db = connection([
    ([parameter]) => { assert.equal(parameter, role); return [validIdentity]; },
    ([limit]) => { assert.equal(limit, validJournal.length + 1); return validJournal; },
    ([names]) => {
      assert.ok(Array.isArray(names));
      assert.ok(names.includes("clinical_notes") && names.includes("note_versions") && names.includes("appointments"));
      return [{ count: names.length }];
    },
  ]);
  await checkDatabase(db.client, role, 1000);
  assert.equal(db.closeCount(), 1);
  assert.equal(db.queries.length, 3);
  assert.ok(db.queries.every((query) => query.startsWith("select") && !query.includes(role)));
  assert.match(db.queries[0], /pg_catalog\.pg_is_in_recovery\(\) as in_recovery/);
  assert.ok(db.queries[1].includes("from drizzle.__drizzle_migrations"));
  assert.ok(db.queries[2].includes("namespace.nspname = 'public'"));
  assert.throws(() => resolveExpectedRole({}), { code: "DB_CHECK_ROLE_REQUIRED" });
});

test("preflight closes on rejected version, role, journal and schema checks", async () => {
  const identity = () => [validIdentity];
  const journal = () => validJournal;
  const cases: [Read[], string, number][] = [
    [[() => [{ ...validIdentity, version: 170000 }]], "DB_CHECK_VERSION_MISMATCH", 1],
    [[() => [{ ...validIdentity, role_matches: false }]], "DB_CHECK_ROLE_MISMATCH", 1],
    [[() => [{ ...validIdentity, in_recovery: true }]], "DB_CHECK_NOT_WRITABLE", 1],
    [[identity, () => validJournal.slice(1)], "DB_CHECK_JOURNAL_MISMATCH", 2],
    [[identity, () => [{ ...validJournal[0], hash: "different" }, ...validJournal.slice(1)]], "DB_CHECK_JOURNAL_MISMATCH", 2],
    [[identity, () => { throw new Error("private driver diagnostic"); }], "DB_CHECK_JOURNAL_UNAVAILABLE", 2],
    [[identity, journal, () => [{ count: 0 }]], "DB_CHECK_SCHEMA_MISMATCH", 3],
    [[() => { throw new Error("private driver diagnostic"); }], "DB_CHECK_FAILED", 1],
  ];
  for (const [reads, code, count] of cases) {
    const db = connection(reads);
    await assert.rejects(checkDatabase(db.client, "fixture_runtime", 1000), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, code);
      assert.doesNotMatch(error.message, /private driver diagnostic/);
      return true;
    });
    assert.equal(db.closeCount(), 1);
    assert.equal(db.queries.length, count);
  }
});

test("preflight closes once when a metadata response misses the deadline", async () => {
  const db = connection([() => new Promise(() => {})]);
  await assert.rejects(checkDatabase(db.client, "fixture_runtime", 10), { code: "DB_CHECK_TIMEOUT" });
  assert.equal(db.closeCount(), 1);
});
