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
   `CBQ_RUNTIME_PASSWORD` in that short-lived child environment. Set the libpq
   inputs `PGHOST`, `PGPORT`, `PGDATABASE=postgres` and `PGUSER` to this fixture
   and its bootstrap login. Supply its password through the child environment,
   with `PGSSLMODE=verify-full` and `PGSSLROOTCERT` pointing to the fixture CA.

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
   objects. PostgreSQL preserves the original owner on existing tables. For the
   grant and catalog commands, select the corresponding fixture database and
   login in the libpq inputs while retaining verified TLS.
5. Seed the source fixture once in a separate bootstrap process. The bundled
   `pnpm db:seed` uses its own client and reads `DATABASE_URL`. Use only the
   intended fixture database and keys for that command. Its direct Postgres.js
   client uses a URL with `sslmode=verify-full` and `NODE_EXTRA_CA_CERTS` pointing
   to the fixture CA; the managed factory settings do not configure this client.
   Save the migrator's connection input for migration and backup operations.
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

## Establish a supported-release upgrade baseline

Before calling a trial a supported-release upgrade, inspect the support policy,
published releases and tags. Record the exact previous release source, its
lockfile and installed dependency provenance. Use that release's application
and migration entry points before moving to the candidate. Preserve synthetic
data without resetting or reseeding it, then verify the candidate's ordinary
application reads and writes. Running historical migration SQL with current
dependencies establishes only that particular schema rehearsal.

At the November 26, 2026 qualification baseline, the policy supports `main`
only, and the published release and tag inventories are empty. There is no
previous supported release to qualify. An internal checkpoint or arbitrary
commit does not supply one. Record this result as unavailable, retain the
historical rehearsal's narrower result, and leave the release-support and
upgrade policy open. A lockfile matching the current candidate establishes
current dependency provenance; it cannot establish an absent release baseline.

## Rehearse physical PITR with Redis and key recovery

Use a new disposable cluster and fresh synthetic data for this rehearsal.
Logical dumps cannot supply the physical base backup required for WAL replay.
Use the same PostgreSQL major and compatible client tools for backup and
recovery. Keep backup material, database credentials, TLS material and application
keys in the private fixture storage, outside the repository. Never print key
values or include them in command arguments or retained logs.

1. Start the ordinary source application with the fixture role profile and
   verified TLS. Enable continuous WAL archiving in this owned fixture before
   taking its physical base backup. Use an archive command that refuses to
   overwrite an existing segment. Record the cluster system identifier,
   PostgreSQL patch and archive status. Use the fixture bootstrap administrator
   for `pg_basebackup`; runtime and migration grants stay unchanged.
2. Take a physical `pg_basebackup` with a backup manifest and the WAL required
   to make it consistent. Verify it with `pg_verifybackup`. After backup
   completion, use the real portals to create and sign a synthetic note and
   book an appointment. This ensures recovery must replay changes newer than
   the base backup. Verify the note's history and applicable ordinary effects.
3. Stop all application writers and queue workers, including the gateway's
   background work. Capture table fingerprints, the complete journal and
   sequences, ownership and grants, the signed note/history, keyed lookup and
   delayed reminder records. Create a uniquely named PostgreSQL restore point.
   Switch WAL and wait until the archive contains the segment holding that
   point, without archiver failures. The named point defines the recovery
   boundary; wall-clock timings alone do not prove it.
4. With writers stopped, take a Redis RDB snapshot and an independent backup
   of all synthetic application keys needed for this fixture. Record backup
   integrity without recording secret values. Resume only the source gateway
   and portals long enough to create a distinct later note through the UI.
   Stop them and verify that this write exists on the source after the chosen
   boundary. Switch WAL again, archive through this later write and include
   that WAL in the recovery inputs. Its exclusion after replay can then prove
   the named target stopped recovery despite later WAL being available. Do not
   advance the saved Redis or key backup to this later state.
5. Copy the base backup, required WAL and RDB to independent private storage.
   Remove the owned source PostgreSQL and Redis containers and their original
   data volumes. Restore into fresh owned containers. Configure PostgreSQL's
   `restore_command`, `recovery_target_name` and target action with a
   `recovery.signal` file. Require its recovery log to identify the named point
   and completion of recovery. Remove the copied active WAL before replay only
   as prescribed by the PostgreSQL recovery procedure; preserve the archived
   WAL and backup manifest used for verification.
6. Restore the RDB before Redis starts. Use a clean data directory, the intended
   `dir` and `dbfilename`, and explicit `appendonly no`; an enabled AOF takes
   precedence over an RDB. Verify the startup log reports loading the RDB.
   Discard the active synthetic application
   key values and reload them from the independent backup. Compare the saved
   and recovered key fingerprints, then verify decryption and keyed lookup
   through the actual application libraries. This exercises retrieval of
   existing keys; it does not qualify rotation or a remote key manager.
7. Before restarting any application writer, require the recovered table,
   journal, sequence and owner/grant snapshots to match the target. Require the
   target note to exist and the later note to be absent. Verify Redis reminder
   records against the frozen snapshot before workers can mutate them. Run
   `pnpm db:check` using the runtime identity and verify both connection
   factories' identities and TLS on the recovered primary.
8. Resume only the recovered application. In the real portals, read the
   original signed note and history, verify the appointment, create and sign a
   fresh note, and book another appointment. Independently verify that the new
   signed note postdates recovery readiness. Correlate the ordinary successful
   `notes.sign` audit by signer and time. If its resource ID is empty, record
   this temporal association explicitly. Observe each portal's session behavior
   before signing in again; report a required fresh login
   separately from successful data recovery. Record queue/outbox outcomes,
   terminal review states and any external processing omitted from the trial.
9. Stop and remove only this run's owned processes, containers and volumes.
   Delete private backups, RDB, keys and TLS working material after retaining
   redacted results and integrity evidence. Verify no owned listener or private
   payload remains. Preserve failed phases and their diagnostics alongside any
   corrected run; an incomplete run is not successful qualification.

This procedure checks one coordinated, quiesced synthetic recovery boundary.
It does not establish consistency between independently timed live backups,
arbitrary queue replay, provider failover, backup retention or customer RPO/RTO.
Report base-backup, target capture, replay, application readiness and observed
workflow durations separately. Include human interaction in elapsed timings
when it falls inside a measured interval. Local key-file retrieval does not
qualify key custody, offsite recovery, revocation or rotation.

References: [PostgreSQL 16 continuous archiving and PITR](https://www.postgresql.org/docs/16/continuous-archiving.html),
[pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html),
[pg_verifybackup](https://www.postgresql.org/docs/16/app-pgverifybackup.html),
and [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).
