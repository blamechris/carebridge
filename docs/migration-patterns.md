# Migration Patterns: Adding CHECK / FK / NOT NULL to Populated Columns

Drizzle emits the SQL exactly as written. Postgres validates new
constraints against existing rows by default. That combination is what
makes a "small" migration block a deploy on a populated table.

This doc covers the two safe patterns for adding a CHECK constraint
(or a FOREIGN KEY, or a NOT NULL) on a column that already has live
production rows. The choice between them is driven by how confident
you are that the existing data passes the constraint.

## Why this matters

A plain `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` does two
things in one statement:

1. Acquires an `ACCESS EXCLUSIVE` lock on the table.
2. Scans every existing row and evaluates the predicate. If any row
   fails, the statement aborts and the migration rolls back.

Concretely:

- **On any table with violating rows**, deploy fails. The migration
  runner exits non-zero, the release pipeline halts, and you find out
  about the bad data the hard way — at deploy time, with the table
  half-locked behind a transaction the runner is rolling back.
- **On a large table** (think `audit_log` after a year of writes, or
  a 50M-row vitals/labs table), the full-table scan under
  `ACCESS EXCLUSIVE` is itself the outage — every read and write to
  the table queues behind the migration until it finishes.

Neither failure mode is acceptable in production. The patterns below
avoid both.

## Pattern A: Pre-clean then add

Use when offending rows are **rare and known** — typically because
you already ran an audit query and can enumerate them, or because the
column has a narrow value distribution and you can write a deterministic
sweep.

Both statements live in the same migration file so the change rolls
forward atomically:

```sql
-- packages/db-schema/drizzle/00XX_users_email_not_empty.sql

-- 1. Sweep the violators. Empty-string emails came from a legacy
-- registration path (#nnnn) that has since been fixed; the count is
-- known small (audit query in PR description).
UPDATE users
SET email = NULL
WHERE email = '';

-- 2. Now the table is clean, add the constraint.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_not_empty;
ALTER TABLE users
  ADD CONSTRAINT users_email_not_empty
  CHECK (email IS NULL OR email != '');
```

**Trade-offs**

- All-or-nothing: if the cleanup `UPDATE` fails (lock timeout, FK
  cascade surprise, trigger error), the transaction rolls back and
  the constraint never lands. You're no worse off than before, but
  you also haven't made progress.
- The `UPDATE` still takes a row-level write lock on every affected
  row, and the `ADD CONSTRAINT` still takes `ACCESS EXCLUSIVE` and
  full-scans. Both are fine for small tables; on a 50M-row table,
  prefer Pattern B.
- The cleanup logic is committed alongside the constraint, so the
  next person reading the migration sees exactly what was swept and
  why.

## Pattern B: NOT VALID + VALIDATE

Use when offending rows are **common, unknown, or the table is large
enough that an `ACCESS EXCLUSIVE` full-scan is itself the problem**.

`NOT VALID` is a Postgres feature on `CHECK` and `FOREIGN KEY`
constraints (not on `NOT NULL` columns directly — for NOT NULL, see
"NOT NULL on a populated column" below). The constraint is recorded
in the catalog and **enforced on every future INSERT and UPDATE from
that moment forward**, but Postgres skips the validating scan of
existing rows. The `ADD CONSTRAINT ... NOT VALID` statement takes
`ACCESS EXCLUSIVE` only briefly — long enough to update the catalog
— and returns in milliseconds even on huge tables.

A separate later `VALIDATE CONSTRAINT` statement performs the
existing-row scan. Crucially, `VALIDATE CONSTRAINT` takes only
`SHARE UPDATE EXCLUSIVE`, not `ACCESS EXCLUSIVE` — concurrent reads
and writes are not blocked.

### Migration 1: add as NOT VALID

```sql
-- packages/db-schema/drizzle/00XX_users_email_not_empty.sql

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_not_empty;
ALTER TABLE users
  ADD CONSTRAINT users_email_not_empty
  CHECK (email IS NULL OR email != '')
  NOT VALID;
```

After this deploys, **no new row can violate the constraint** —
inserts and updates are checked normally. Only the existing rows are
unvalidated.

### Backfill: one-shot job

Run a separate ops job (script, manual `psql`, or BullMQ task —
follow the team's existing backfill conventions) to sweep the
historical violators. This is decoupled from the schema migration,
so you can:

- Batch the cleanup (e.g. `UPDATE ... WHERE id IN (SELECT id FROM users WHERE email = '' LIMIT 10000)` in a loop) to avoid one giant write transaction.
- Run it during off-peak hours independent of the deploy window.
- Retry it if it fails partway, since `NOT VALID` is already
  protecting against new violators.

### Migration 2: VALIDATE the constraint

Once the backfill confirms zero violating rows remain:

```sql
-- packages/db-schema/drizzle/00YY_users_email_not_empty_validate.sql

ALTER TABLE users
  VALIDATE CONSTRAINT users_email_not_empty;
```

This scans the table once under `SHARE UPDATE EXCLUSIVE` and, on
success, flips the constraint's `convalidated` flag in `pg_constraint`
from false to true. From this point on, the constraint is
indistinguishable from one added the plain way.

**Trade-offs**

- Spans (at minimum) two deploys, with a backfill step in between.
  The team needs to track that the second migration is owed.
- During the window between migration 1 and migration 2, the
  constraint shows as `NOT VALID` in introspection (`\d+` in psql,
  `convalidated = false` in `pg_constraint`). That's fine for runtime
  correctness — enforcement on new writes is unconditional — but
  monitoring or schema-diff tooling may surface it as a finding.
- If you forget the `VALIDATE` step, future schema dumps will keep
  emitting the constraint as `NOT VALID`, which propagates the lie
  to fresh DBs (test, staging) that *do* have a clean state. Track
  the `VALIDATE` migration as a follow-up issue at the time you
  merge the `NOT VALID` one.

### FK-specific note: reduced lock level

`ADD CONSTRAINT ... FOREIGN KEY` is the one exception to the
`ACCESS EXCLUSIVE` rule. Per the
[Postgres 16 ALTER TABLE docs](https://www.postgresql.org/docs/16/sql-altertable.html):

> Although most forms of ADD _table_constraint_ require an ACCESS
> EXCLUSIVE lock, ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE
> lock. Note that ADD FOREIGN KEY also acquires a SHARE ROW EXCLUSIVE
> lock on the referenced table, in addition to the lock on the table
> on which the constraint is declared.

In practice this means:

- `ALTER TABLE child ADD CONSTRAINT ... FOREIGN KEY (parent_id) REFERENCES parent (id) NOT VALID`
  blocks other writers (`SHARE ROW EXCLUSIVE` conflicts with itself
  and with `ROW EXCLUSIVE`-holding statements like concurrent DDL
  and `VACUUM FULL`) **but does not block plain reads or row-level
  INSERT/UPDATE/DELETE**, which use weaker `ROW SHARE` /
  `ROW EXCLUSIVE` locks. A CHECK constraint added the same way
  would freeze the table.
- The two-step rollout is still required when the column is
  populated: add `NOT VALID`, backfill any orphan rows that don't
  resolve to a parent, then `VALIDATE CONSTRAINT`. `VALIDATE` takes
  the same `SHARE UPDATE EXCLUSIVE` as for CHECK (plus a `ROW SHARE`
  on the referenced table), so it does not block reads or writes.
- New INSERTs and UPDATEs are FK-checked from the moment the
  `NOT VALID` constraint lands — only pre-existing rows are
  unvalidated.

No worked example yet because the repo has no FK-on-populated-column
migration to point at. The pattern is documented here so the next
person reaching for it knows the lock floor is lower than the CHECK
case above.

### NOT NULL on a populated column

Plain `ALTER TABLE ... ALTER COLUMN x SET NOT NULL` is the same trap
as `ADD CONSTRAINT` — it scans every row.

Workaround on Postgres 12+: add a `CHECK (x IS NOT NULL) NOT VALID`,
backfill the NULLs, `VALIDATE CONSTRAINT`, then
`ALTER COLUMN x SET NOT NULL`. The final `SET NOT NULL` will skip the
table scan if it finds a validated `IS NOT NULL` CHECK already
covering the column.

## Worked example: PR #1157

[PR #1157](https://github.com/blamechris/carebridge/pull/1157) added
two CHECK constraints to `users` —
[`packages/db-schema/drizzle/0053_npi_nucc_check.sql`](../packages/db-schema/drizzle/0053_npi_nucc_check.sql):

```sql
ALTER TABLE users
  ADD CONSTRAINT users_npi_shape_chk
  CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$');

ALTER TABLE users
  ADD CONSTRAINT users_nucc_code_shape_chk
  CHECK (nucc_code IS NULL OR nucc_code ~ '^[A-Z0-9]{5}0000[A-Z]$');
```

That migration uses a **plain ADD CONSTRAINT** — neither Pattern A
nor Pattern B. **It is safe ONLY because**:

- The `npi` and `nucc_code` columns were freshly introduced in
  [PR #1141](https://github.com/blamechris/carebridge/pull/1141), and
- No production code path has written a non-NULL value into either
  column yet — the FHIR Practitioner generator that consumes them
  treats both as opt-in, and the columns are nullable.

In other words, the columns existed in the schema but contained only
NULLs in every environment. The validating scan that
`ADD CONSTRAINT` triggers had no work to do.

**Do not copy this pattern for a populated column.** The next time
someone adds a CHECK on a column with real values, pick Pattern A or
Pattern B based on the data shape.

## Quick decision guide

| Situation | Pattern |
|---|---|
| Column is brand new in this PR or a recent one, no production writes yet | Plain `ADD CONSTRAINT` is fine (see PR #1157) |
| Column has data, violators are known and few, table is small | Pattern A (pre-clean then add) |
| Column has data, violators are unknown or many, or table is large | Pattern B (NOT VALID + backfill + VALIDATE) |
| Adding NOT NULL to a populated column | Pattern B with `CHECK (x IS NOT NULL) NOT VALID`, then `SET NOT NULL` |

## Notes specific to CareBridge

- `audit_log` is append-only (see [`hipaa-retention.md`](./hipaa-retention.md)).
  Any constraint added to `audit_log` cannot be backfilled with an
  `UPDATE` sweep — the immutability triggers will reject it, and the
  migration role must remain distinct from the runtime role. If
  `audit_log` rows violate a proposed constraint, the only viable
  path is Pattern B with the violators left as a known historical
  artefact; the constraint enforces correctness going forward but
  cannot be `VALIDATE`d until every violating row ages out under the
  7-year retention window.
- Drizzle migrations live in `packages/db-schema/drizzle/`. Both
  migrations in a Pattern B pair should follow the existing
  `NNNN_short_name.sql` numbering and reuse the
  `DROP CONSTRAINT IF EXISTS` idempotency prelude already used by
  migrations 0026, 0038, and 0053.
