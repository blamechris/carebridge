# PostgreSQL connection configuration

CareBridge retains its bundled local development database and adds an explicit
connection contract for a dedicated, operator-managed PostgreSQL 16 database.
This configuration foundation does not qualify a customer/provider topology.
Issue #1365 remains open; the separate note lifecycle work remains in #916.

## Configuration and process boundaries

`pnpm db:migrate`, `pnpm db:check` and `pnpm db:seed` do not automatically load
`.env`. Inject an exported environment from
your deployment's secret manager or explicitly load only a trusted,
shell-compatible local file. Never put connection values in a portal, source,
command transcript, checked-in example or diagnostic output.

| Setting | Local development | Managed connection |
| --- | --- | --- |
| `DATABASE_MODE` | `local-dev`; omitted only with unset, development or test `NODE_ENV` | `managed`; production requires this explicitly |
| `DATABASE_URL` | Existing URL or bundled loopback fallback | Required runtime/preflight URL; no fallback |
| `DATABASE_MIGRATION_URL` | Migration may use the development URL | Required only in the migration job; never substituted with the runtime URL |
| `DATABASE_TLS_CA_FILE` | Ignored; TLS retains the existing URL/driver behavior | Required absolute path to a mounted PEM CA file; chain and endpoint hostname/IP validation remain enabled |
| `DATABASE_POOL_MAX` | Driver baseline 10 unless explicitly set | Required positive integer 1–50 for each runtime process |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | Default 30 | Integer 1–60, default 30; connection establishment only |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | Driver baseline: idle close disabled when omitted | Integer 1–600, default 30 |
| `DATABASE_EXPECTED_ROLE` | Required by preflight | Required by preflight; compare identity without printing its value |

The migrator always uses one connection. Managed URLs select one explicit
PostgreSQL endpoint with a user and database; query parameters and fragments are
rejected. Supply TLS, pool and timeouts through the named settings. Ambient
`PG*` variables cannot change the managed connection. The first contract uses
one mounted trust root set for both purposes; differing runtime/migration trust
roots need separate qualification. Managed endpoints must be writable. The driver uses
`target_session_attrs=read-write` for its default-read-only check; preflight also
rejects `pg_is_in_recovery()`. Runtime does not continuously recheck recovery
state, so failover/read-replica qualification remains outside this contract. CA bundles must be regular PEM files
no larger than 1 MiB. External poolers and client certificate identity are outside
this increment.

`getDb()` stays synchronous and connects lazily on first use. Its cached client
is per process. Configuration is validated when that client is constructed;
preflight is a separate operator step, not a replacement for process supervision.
The connect timeout is not a query deadline. Full multi-service graceful shutdown
instrumentation is a follow-on; short-lived migration/check clients close on both
success and failure.

Runtime environments contain only runtime settings. Never export the migration
endpoint into a shared service shell. Turbo's strict environment allowlist
forwards runtime connection names and omits `DATABASE_MIGRATION_URL` and
`DATABASE_EXPECTED_ROLE`. Migration and preflight run directly in their dedicated
short-lived environments through these root commands:

```bash
pnpm db:migrate
pnpm db:check
```

Migration, check, seed and schema generation scripts use Node with the installed
`--import tsx` loader. This resolves the schema's `.js` import specifiers to its
TypeScript sources and avoids the `tsx` CLI control socket.

These examples contain command names only. An operator supplies secret references
at the process boundary; no generic shell sourcing or secret-manager integration
is added. SQL generation is database-offline through `pnpm db:generate`. Drizzle Kit may
load a package-local `.env` itself; the generation config contains no connection
credentials, and generating SQL does not establish database connectivity.

## Stop, migrate, check, start

1. Confirm the dedicated database, endpoint, PG16 version, mounted CA, application
   keys and backups are the intended deployment. Provisioning is operator-owned;
   these commands do not create roles or change grants.
2. Stop application services and workers. Designate one migration job; serialize
   upgrades and keep all replicas stopped for this initial procedure.
3. Inject only the migration environment and run `pnpm db:migrate`. Managed mode
   requires `DATABASE_MIGRATION_URL` and CA. Success emits `DB_MIGRATION_OK`.
4. Start a separate environment with runtime URL, bounded pool, CA and expected
   runtime role; omit migration settings. Run `pnpm db:check`. Success emits
   `DB_CHECK_OK` after PG16, non-recovery, current-role and exact
   migration-baseline checks.
5. Start services/workers with runtime settings and no migration endpoint.
   Use ordinary portal actions and audit/outbox checks to verify the deployment.
   Existing `/health` endpoints retain their existing liveness semantics.

A missing/unsupported setting, TLS failure, wrong role or absent/divergent schema
returns nonzero with a stable redacted `DB_*` code. Resolve the indicated
configuration/schema prerequisite; do not retry with disabled verification, a
fallback database or reseeding. Preserve only code, command, timing and
sanitized counts/booleans in operator evidence. Raw driver errors may contain
connection details and must not be published.

The runtime preflight identity needs `USAGE` on the `drizzle` schema and `SELECT`
on `drizzle.__drizzle_migrations`, in addition to its separately reviewed
application privileges. These are operator-supplied prerequisites; this package
changes no grants. `DB_CHECK_JOURNAL_UNAVAILABLE` can mean missing metadata access
or an absent journal; it is distinct from a role mismatch.

Preflight reads PostgreSQL metadata and the installed migration journal; it does
not initialize a schema, migrate, seed or write clinical data. A passing check is
not a complete permissions audit, full schema-equivalence check or proof of
application readiness. CLI redaction does not replace application-level query
error handling. Keep the
runtime identity distinct from the migrator in a real deployment, and separately
review its object privileges under [migration guidance](migration-patterns.md).

## Connection budget

Inventory every database-using process and replica before assigning caps. Each
process can create its own pool; counting one gateway misses workers and scale-out.

| Process class in the bounded local fixture | Replicas | Cap per process | Budget |
| --- | ---: | ---: | ---: |
| Gateway | 1 | 2 | 2 |
| AI oversight | 1 | 2 | 2 |
| Notifications | 1 | 2 | 2 |
| Scheduling | 1 | 2 | 2 |
| Migrator (application stopped) | 1 | 1 | 1 |
| Preflight/evidence client | 1 | 2 | 2 |
| Operator headroom | — | — | 5 |
| Conservative total | — | — | 16 |

The fixture target is `max_connections=30`; PostgreSQL's reserved connections
must also fit. This worksheet is a planned bound until recorded alongside an
actual backend inventory, observed peak and configured caps. Portals call the
gateway rather than opening their own pools. Include any additional services,
seed jobs, test processes and replicas in other deployments. Stop seed/test
clients before ordinary-flow pool sampling. Migrations and services do not run
concurrently in the supported first procedure, although the worksheet reserves
both conservatively. Pool saturation queues driver work; neither a cap nor a
connect timeout promises a bounded SQL execution time.

## Qualification record and support boundary

Use only owned disposable fixtures, synthetic data and local TLS material, after
normal workload admission. Record the tested commit, PG patch, Node22,
Postgres.js 3.4.9, mode, command results and cleanup inventory. Demonstrate the
bundled path, actual factory TLS success and certificate/hostname rejection,
purpose routing, runtime environment omission, managed restart without reseed,
ordinary clinician/patient actions, audit/outbox persistence, observed pool cap
and a controlled local disconnect/recovery. Configuration tests alone cannot
establish any of these integration results.

A fixture initialized with only the container's bootstrap identity cannot qualify
distinct runtime/migrator identities or least privilege. Separate names and
process environments establish routing/isolation only. The connection foundation changes no
roles, memberships, schema grants or access policies. Its identity qualification
requires separately provisioned roles; no superuser result discharges it.

The [local qualification runbook](postgresql-local-qualification.md) adds a
separate disposable-fixture procedure for distinct runtime/migration identities,
explicit grants, logical restore and one historical schema transition. Record
the observed results and remaining gates for each rehearsal before claiming it
qualified. The scripts apply only to newly created fixture identities and objects.

Exact journal checks include historical SQL bytes. Older installations can
retain hashes from earlier versions of already-applied files, even when their
schema is compatible. The existing migrator only applies newer timestamps;
rerunning `db:migrate` does not repair those historical mismatches. Stop on
`DB_CHECK_JOURNAL_MISMATCH` and use a separately reviewed upgrade/reconciliation
procedure. Never rewrite journal rows merely to make preflight pass.

Before declaring a topology supported, also require a separately authorized
provider/private-network matrix, reviewed role grants, previous-supported-release
upgrade policy and a measured isolated restore using the original encryption and
HMAC keys. Verify protected-field reads/lookups, row identity and queue/outbox
reconciliation after controlled resume. Local logical restore evidence does not
establish PITR or customer RPO/RTO. No production, provider, residency, compliance
or clinical-readiness claim follows from local configuration results.

## Operational ownership to assign before deployment

| Responsibility | Customer/private deployment owner | Service support owner |
| --- | --- | --- |
| PostgreSQL patching, capacity, availability | Database operator | Publish qualified versions and app requirements |
| Application upgrades and coordinated migrations | Deployment operator | Supply compatibility policy and migration instructions |
| Private DNS, routes, firewall and endpoint reachability | Network operator | Supply documented endpoint/TLS requirements |
| Database secrets, app encryption/HMAC keys, rotation/revocation | Security/key custodian | Document key lifecycle and app integration contract |
| Audit access/export, logs, monitoring and alert response | Operations/audit custodian | Supply redacted signal definitions and triage guidance |
| Backup retention/deletion, restore drills and incident recovery | Database/key/queue operators | Supply reconciliation and application verification procedure |
| Export, offboarding and verified deletion including retained backups | Data owner and backup custodian | Supply supported export/deletion behavior and its limits |

Assign named people, escalation contacts, recovery targets and drill cadence in
the deployment's private operating record. Account for application processing,
Redis payloads, logs, backups, keys, exports, monitoring and optional integrations
alongside database placement. No provider or operation is assigned by this table.

References: [pinned driver connection and lifecycle options](https://github.com/porsager/postgres/blob/v3.4.9/README.md#connection-details),
[Node22 TLS verification](https://nodejs.org/download/release/latest-v22.x/docs/api/tls.html),
[PostgreSQL16 backup approaches](https://www.postgresql.org/docs/16/backup.html).
