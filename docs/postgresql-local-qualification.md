# Local PostgreSQL 16 qualification

Use this procedure for a dedicated disposable PostgreSQL 16 cluster and a local
CareBridge stack with synthetic data and keys. Run it under normal local
workload admission. Use the fixture's PostgreSQL 16 client tools and the
repository's installed runtime. Record the tested commit, PostgreSQL patch,
driver version and elapsed backup and restore time. See the regular deployment
and environment contract in [PostgreSQL connections](postgresql-connections.md).

## Provision the fixture

1. Start the owned PostgreSQL cluster and Redis using a unique run namespace.
   Keep client listeners on loopback and use the fixture CA with hostname
   verification for managed PostgreSQL connections.
2. Give the run a prefix matching `cbq_` followed by eight lowercase hexadecimal
   characters. The cluster bootstrap login must be the prefix plus `_admin`.
   Run [role provisioning](../tooling/qualification/pg16-fixture-roles.sql)
   against `postgres` as that login. Supply `CBQ_MIGRATOR_PASSWORD` and
   `CBQ_RUNTIME_PASSWORD` in that short-lived child environment.

   ```sh
   psql -X -q -v ON_ERROR_STOP=1 -v fixture_prefix="$CBQ_PREFIX" \
     -f tooling/qualification/pg16-fixture-roles.sql
   ```

   The command creates distinct `_migrator` and `_runtime` logins in one transaction
   and emits `CBQ_ROLES_OK`. Use fresh synthetic values that never enter command
   arguments, checked-in files or persistent shell history. Redact both client
   output streams and any database logs before retaining evidence. Server
   logging follows the fixture's existing configuration.
3. Use the bootstrap login to create the `_source` database owned by the new
   migrator and grant the new runtime login `CONNECT` on it. Use distinct
   `_restore` and `_upgrade` databases for the later steps. Create each one
   empty with the same owner and grant runtime `CONNECT` before use.
4. Run `pnpm db:migrate` from the repository root using
   `DATABASE_MIGRATION_URL` for the migrator. Require `DB_MIGRATION_OK`.
   Run [fixture grants](../tooling/qualification/pg16-fixture-grants.sql) as
   the migrator on that database using the same `psql` flags and prefix. Require
   `CBQ_GRANTS_OK`. The grants require a matching database, database owner and
   restricted roles. Review the explicit table list again when a migration adds
   objects. PostgreSQL preserves the original owner on existing tables.
5. Seed the source fixture once in a separate bootstrap process. The bundled
   `pnpm db:seed` uses its own client and reads `DATABASE_URL`. Use only the
   intended fixture database and keys for that command. Save the migrator's
   connection input for migration and backup operations.
6. In an isolated runtime environment, set `DATABASE_URL` and
   `DATABASE_EXPECTED_ROLE` for the runtime login, omit migration settings, and
   run `pnpm db:check`. Require `DB_CHECK_OK`. Start the application processes
   using that same runtime profile.

The role and grant files apply to newly created fixture identities and
objects. Operators provision roles separately from the regular migration command
and application startup. The scripts leave PostgreSQL's existing PUBLIC grants
and default privileges in place.

## Verify the runtime profile

| Grant | Scope |
| --- | --- |
| Database `CONNECT` and schema `USAGE` | Fixture database and the `public` and `drizzle` schemas |
| `SELECT` | The Drizzle journal and only the application read tables listed in the grant file |
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `sessions` for sign-in, refresh and cleanup |
| `SELECT`, `INSERT`, `UPDATE` | Notes, appointments, clinical flags, review jobs, notifications and failed clinical events |
| `SELECT`, `INSERT` | `note_versions` and `provider_schedules` |
| `INSERT` | `audit_log` |

Use [the catalog check](../tooling/qualification/pg16-fixture-catalog.sql) with
the same prefix and `psql -X -qAt -v ON_ERROR_STOP=1` to collect one JSON object
of booleans and counts. Confirm both logins connect as themselves, role
attributes and membership match, the migrator owns the database and objects,
and the runtime object's effective privileges match the specified profile.
Confirm the runtime can read the journal with use of its schema. The journal's
sequence belongs to the migrator. The catalog also records the enabled audit
and allergy-override triggers, their function owners and invoker execution.
The checks read system catalogs and issue no test mutations.

Run portal sign-in, note draft/sign/history, and appointment booking,
rescheduling and cancellation with the fixture runtime login. Check the
applicable deterministic review, notification and outbox effects. Read audit
rows in a separate read-only observer transaction with the fixture owner.
The audit grant follows the existing [insert-only audit contract](hipaa-retention.md#known-limitation-owner-drop-trigger).
FHIR patient export reads prior records from `audit_log` and requires a
separately reviewed profile. The fixture profile includes the allergy-override
read used by the review worker. Changing override records, account settings,
notification preferences, other integrations and maintenance jobs lie outside
these exercised paths.

On a fresh PostgreSQL 16 install, PUBLIC normally supplies database `CONNECT`
and `TEMPORARY`, function execution and type usage. The `public` schema also
allows PUBLIC usage. The fixture catalog records the database grants. The
result qualifies the named application operations and the checked object
privileges on this fixture. A provider or production privilege review still
needs its own deployment scope. [PostgreSQL 16 privilege defaults](https://www.postgresql.org/docs/16/ddl-priv.html)

## Rehearse logical restore

1. Stop application writers and queue workers. Use a source and restore database
   from the same owned fixture. Capture the exact journal, table counts,
   deterministic row fingerprints and relevant outbox states while writers
   are stopped. Keep the original synthetic `PHI_ENCRYPTION_KEY` and
   `PHI_HMAC_KEY` if it was used for the fixture.
2. Use the fixture migrator's libpq connection environment and
   `pg_dump --format=custom --file="$CBQ_ARCHIVE"` for the source. Restore into
   the precreated empty destination as its owner with
   `pg_restore --single-transaction --no-owner --dbname="$CBQ_RESTORE_DB" "$CBQ_ARCHIVE"`.
   Existing fixture principals resolve the archived object grants, which are
   retained by default. The destination provisions database-level ownership
   and `CONNECT` separately. Record timings and archive integrity without
   retaining fixture plaintext or keys in the repository.
3. Compare the destination's journal, pre-resume row fingerprints, owner and
   ACL checks with the source. Run `pnpm db:check` using the runtime login on
   the restore database. Restore application access using the original
   synthetic keys. Check a previously signed note and its history, appointment
   continuity, and an ordinary new write. Verify protected-field decryption
   through the application and any synthetic HMAC-based lookup separately.
4. Resume only the destination stack. Check the restored outbox before and
   after workers resume and record checked queue outcomes. The archive covers
   PostgreSQL only. Cluster roles, application keys and Redis state are
   separate inputs. Retaining the original isolated Redis instance tests
   continuity with that queue state. Redis recovery, key recovery, point-in-time
   recovery, and customer recovery targets require separate qualification.

See [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)
and [PostgreSQL 16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

## Rehearse one historical schema upgrade

Provision a fresh owned upgrade database. Use historical commit
`5f6577606bbe71fd6b593f9e09ade03218b2c3f2` and its ordinary migrator to apply
the 60 journal entries ending at migration `0055`. Insert a synthetic fixture
and record its data before the transition. Keep application writers stopped
while applying the current `pnpm db:migrate`. Confirm the 60 original timestamp
and hash pairs remain unchanged, exactly one `0056` row was appended, and both
diagnosis lookup indexes include `onset_date`. Verify the original synthetic
rows are intact. Apply the reviewed fixture grants, run runtime `pnpm db:check`,
and check the same data through ordinary application reads. Record the precise
historical anchor and command used.

This transition is a rehearsal between two repository schemas. CareBridge's
[security policy](../SECURITY.md#supported-versions) identifies the main branch
as supported. A previous-supported-release upgrade and broader historical
journal reconciliation still require separate baselines and verification.
