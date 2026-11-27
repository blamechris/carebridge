import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import test from "node:test";
import { createDatabaseClient } from "../database-client.js";
import { resolveDatabaseConfig } from "../database-config.js";

const runtimeUrl = "postgresql://reader@runtime.test/workspace";
const migrationUrl = "postgresql://migrator@[::1]:5434/workspace";
const managed = Object.freeze({
  NODE_ENV: "production",
  DATABASE_MODE: "managed",
  DATABASE_URL: runtimeUrl,
  DATABASE_MIGRATION_URL: migrationUrl,
  DATABASE_TLS_CA_FILE: "fixture-ca.pem",
  DATABASE_POOL_MAX: "3",
});

test("bundled development and explicitly supplied local connection strings remain available", () => {
  const bundled = resolveDatabaseConfig(Object.freeze({}), "runtime");
  assert.equal(bundled.mode, "local-dev");
  assert.equal(new URL(bundled.url).hostname, "localhost");
  assert.equal(bundled.poolMax, undefined);
  const explicitUrl = "postgresql://reader@localhost/workspace?sslmode=disable";
  for (const purpose of ["runtime", "migration"] as const) {
    const config = resolveDatabaseConfig({ NODE_ENV: "test", DATABASE_URL: explicitUrl, DATABASE_POOL_MAX: "4" }, purpose);
    assert.equal(config.mode, "local-dev");
    assert.equal(config.url, explicitUrl);
    assert.equal(config.poolMax, purpose === "migration" ? 1 : 4);
  }
  assert.throws(() => resolveDatabaseConfig({ NODE_ENV: "production" }, "runtime"), { code: "DB_MANAGED_REQUIRED" });
  assert.throws(() => resolveDatabaseConfig({ NODE_ENV: "production", DATABASE_MODE: "local-dev" }, "migration"), { code: "DB_MANAGED_REQUIRED" });
  assert.throws(() => resolveDatabaseConfig({ NODE_ENV: "staging" }, "runtime"), { code: "DB_MANAGED_REQUIRED" });
  assert.throws(() => resolveDatabaseConfig({ DATABASE_MODE: "" }, "runtime"), { code: "DB_MODE_INVALID" });
});

test("managed runtime and migration never read the other purpose's URL", () => {
  const runtime = resolveDatabaseConfig(Object.freeze({
    ...managed,
    get DATABASE_MIGRATION_URL(): string { return assert.fail("runtime consulted migration injection"); },
  }), "runtime");
  assert.equal(runtime.mode, "managed");
  assert.equal(runtime.endpoint.hostname, "runtime.test");
  assert.equal(runtime.endpoint.port, 5432);
  assert.equal(runtime.endpoint.user, "reader");
  assert.equal(runtime.poolMax, 3);
  assert.equal(runtime.connectTimeout, 30);
  assert.equal(runtime.idleTimeout, 30);

  const migration = resolveDatabaseConfig(Object.freeze({
    ...managed,
    get DATABASE_URL(): string { return assert.fail("migration consulted runtime injection"); },
    get DATABASE_POOL_MAX(): string { return assert.fail("migration consulted runtime pool settings"); },
  }), "migration");
  assert.equal(migration.mode, "managed");
  assert.equal(migration.endpoint.hostname, "::1");
  assert.equal(migration.endpoint.port, 5434);
  assert.equal(migration.endpoint.user, "migrator");
  assert.equal(migration.poolMax, 1);

  assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_URL: undefined }, "runtime"), { code: "DB_RUNTIME_URL_INVALID" });
  assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_MIGRATION_URL: undefined }, "migration"), { code: "DB_MIGRATION_URL_INVALID" });
});

test("managed URLs reject alternate connection settings and report only redacted diagnostics", () => {
  const invalidUrls = [
    "", "http://reader@runtime.test/workspace", "postgres://runtime.test/workspace",
    "postgres://reader@runtime.test", "postgres://reader@runtime.test:0/workspace",
    "postgres://reader@runtime.test,standby.test/workspace", "postgres://reader@/workspace",
    "postgres://reader@runtime.test/workspace?sslmode=disable",
    "postgres://reader@runtime.test/workspace?host=standby.test&max=100",
    "postgres://reader@runtime.test/workspace?", "postgres://reader@runtime.test/workspace#",
    "postgres://reader@runtime.test/%00", "postgres://reader@runtime.test/%xy",
  ];
  for (const url of invalidUrls) {
    assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_URL: url }, "runtime"), {
      code: "DB_RUNTIME_URL_INVALID",
      message: "Set a valid DATABASE_URL for the runtime endpoint.",
    });
  }
  const encoded = resolveDatabaseConfig({
    ...managed, DATABASE_URL: "postgres://test%40reader:example%23value@runtime.test/work%20space",
  }, "runtime");
  assert.equal(encoded.mode, "managed");
  assert.equal(encoded.endpoint.user, "test@reader");
  assert.equal(encoded.endpoint.password, "example#value");
  assert.equal(encoded.endpoint.database, "work space");
});

test("managed pool and timeout values are explicit whole seconds within bounds", () => {
  for (const value of [undefined, "", "0", "-1", "3.5", "1e1", "51"]) {
    assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_POOL_MAX: value }, "runtime"), { code: "DB_POOL_MAX_INVALID" });
  }
  assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_CONNECT_TIMEOUT_SECONDS: "61" }, "runtime"), { code: "DB_CONNECT_TIMEOUT_INVALID" });
  assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_IDLE_TIMEOUT_SECONDS: "601" }, "migration"), { code: "DB_IDLE_TIMEOUT_INVALID" });
  assert.throws(() => resolveDatabaseConfig({ ...managed, DATABASE_TLS_CA_FILE: "" }, "runtime"), { code: "DB_TLS_CA_INVALID" });
  const config = resolveDatabaseConfig({
    ...managed, DATABASE_POOL_MAX: "50", DATABASE_CONNECT_TIMEOUT_SECONDS: "60", DATABASE_IDLE_TIMEOUT_SECONDS: "600",
  }, "runtime");
  assert.equal(config.poolMax, 50);
  assert.equal(config.connectTimeout, 60);
  assert.equal(config.idleTimeout, 600);
});

test("the pinned driver's managed connection options cannot fall back to ambient settings", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "carebridge-ca-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caFile = join(dir, "fixture.pem");
  writeFileSync(caFile, rootCertificates[0]);
  for (const [name, value] of Object.entries({
    PGHOST: "other.test", PGPORT: "5555", PGUSER: "other", PGDATABASE: "other",
    PGPASSWORD: "sentinel", PGSSL: "prefer", PGSSLNEGOTIATION: "direct", PGMAX: "99",
    PGCONNECT_TIMEOUT: "1", PGIDLE_TIMEOUT: "2", PGTARGETSESSIONATTRS: "invalid",
    PGAPPNAME: "other", PGDEBUG: "true",
  })) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }

  const client = createDatabaseClient(resolveDatabaseConfig({ ...managed, DATABASE_TLS_CA_FILE: caFile }, "runtime"));
  t.after(() => client.close());
  const { options } = client.sql;
  assert.deepEqual(options.host, ["runtime.test"]);
  assert.deepEqual(options.port, [5432]);
  assert.equal(options.user, "reader");
  assert.equal(options.database, "workspace");
  assert.equal((options.pass as unknown as () => string)(), "");
  assert.equal(options.max, 3);
  assert.equal(options.connect_timeout, 30);
  assert.equal(options.idle_timeout, 30);
  assert.equal(options.debug, false);
  assert.equal(options.target_session_attrs, "read-write");
  assert.equal(options.connection.application_name, "carebridge-runtime");
  assert.equal((options as unknown as { sslnegotiation: string }).sslnegotiation, "postgres");
  const ssl = options.ssl as { rejectUnauthorized: boolean; ca: string[] };
  assert.equal(ssl.rejectUnauthorized, true);
  assert.deepEqual(ssl.ca, [rootCertificates[0]]);
  const firstClose = client.close();
  assert.equal(client.close(), firstClose);
  await firstClose;

  const migration = createDatabaseClient(resolveDatabaseConfig({ ...managed, DATABASE_TLS_CA_FILE: caFile }, "migration"));
  t.after(() => migration.close());
  assert.deepEqual(migration.sql.options.host, ["::1"]);
  assert.deepEqual(migration.sql.options.port, [5434]);
  assert.equal(migration.sql.options.max, 1);
  assert.equal(migration.sql.options.connection.application_name, "carebridge-migration");

  writeFileSync(caFile, "invalid PEM");
  assert.throws(() => createDatabaseClient(resolveDatabaseConfig({ ...managed, DATABASE_TLS_CA_FILE: caFile }, "runtime")), {
    code: "DB_TLS_CA_INVALID",
    message: "Set DATABASE_TLS_CA_FILE to a readable PEM certificate bundle.",
  });
});
