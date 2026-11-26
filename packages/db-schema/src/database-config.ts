import { isIP } from "node:net";

const localUrl = "postgresql://carebridge:carebridge_dev@localhost:5432/carebridge";

const messages = {
  DB_MODE_INVALID: "Set DATABASE_MODE to local-dev or managed.",
  DB_MANAGED_REQUIRED: "Set DATABASE_MODE=managed for this environment.",
  DB_RUNTIME_URL_INVALID: "Set a valid DATABASE_URL for the runtime endpoint.",
  DB_MIGRATION_URL_INVALID: "Set a valid DATABASE_MIGRATION_URL for the migration endpoint.",
  DB_POOL_MAX_INVALID: "Set DATABASE_POOL_MAX to an integer from 1 to 50.",
  DB_CONNECT_TIMEOUT_INVALID: "Set DATABASE_CONNECT_TIMEOUT_SECONDS to an integer from 1 to 60.",
  DB_IDLE_TIMEOUT_INVALID: "Set DATABASE_IDLE_TIMEOUT_SECONDS to an integer from 1 to 600.",
  DB_TLS_CA_INVALID: "Set DATABASE_TLS_CA_FILE to a readable PEM certificate bundle.",
  DB_CLIENT_INVALID: "Could not initialize the database client.",
  DB_CLOSE_FAILED: "Could not close the database client.",
  DB_MIGRATION_FAILED: "Could not apply database migrations.",
  DB_CHECK_ROLE_REQUIRED: "Set DATABASE_EXPECTED_ROLE to the expected runtime role.",
  DB_CHECK_TIMEOUT: "Database preflight exceeded its deadline.",
  DB_CHECK_FAILED: "Could not connect to the database or read readiness metadata.",
  DB_CHECK_VERSION_MISMATCH: "Database preflight requires PostgreSQL 16.",
  DB_CHECK_ROLE_MISMATCH: "The active database role differs from the expected runtime role.",
  DB_CHECK_JOURNAL_INVALID: "The packaged database migration history is invalid or unavailable.",
  DB_CHECK_JOURNAL_UNAVAILABLE: "The runtime role could not read the database migration journal.",
  DB_CHECK_JOURNAL_MISMATCH: "The applied migration journal differs from the packaged migration history.",
  DB_CHECK_SCHEMA_MISMATCH: "The runtime schema is missing one or more expected tables.",
} as const;

export type DatabaseErrorCode = keyof typeof messages;

export class DatabaseError extends Error {
  constructor(readonly code: DatabaseErrorCode) {
    super(messages[code]);
    this.name = "DatabaseError";
  }
}

export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export type DatabasePurpose = "runtime" | "migration";

type LocalDatabaseConfig = Readonly<{
  mode: "local-dev";
  url: string;
  poolMax: number | undefined;
  connectTimeout: number | undefined;
  idleTimeout: number | undefined;
}>;

type ManagedEndpoint = Readonly<{
  hostname: string;
  port: number;
  database: string;
  user: string;
  password: string;
}>;

type ManagedDatabaseConfig = Readonly<{
  mode: "managed";
  purpose: DatabasePurpose;
  endpoint: ManagedEndpoint;
  caFile: string;
  poolMax: number;
  connectTimeout: number;
  idleTimeout: number;
}>;

export type DatabaseConfig = LocalDatabaseConfig | ManagedDatabaseConfig;

const localEnvironments = new Set([undefined, "development", "test"]);
const hostnameLabel = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

function parseManagedEndpoint(value: string | undefined, code: DatabaseErrorCode): ManagedEndpoint {
  if (!value || !/^postgres(?:ql)?:\/\//i.test(value) || /[\s?#]/.test(value)) {
    throw new DatabaseError(code);
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const dnsLabels = hostname.replace(/\.$/, "").split(".");
    const port = url.port === "" ? 5432 : Number(url.port);
    const path = url.pathname.slice(1);
    const database = decodeURIComponent(path);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);

    if ((isIP(hostname) === 0 && !dnsLabels.every((label) => hostnameLabel.test(label)))
      || port < 1 || !path || path.includes("/") || !user || [database, user, password].some((field) => field.includes("\0"))) {
      throw new DatabaseError(code);
    }

    return { hostname, port, database, user, password };
  } catch {
    throw new DatabaseError(code);
  }
}

function optionalInteger(value: string | undefined, max: number, code: DatabaseErrorCode): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > max) throw new DatabaseError(code);
  return number;
}

export function resolveDatabaseConfig(env: DatabaseEnvironment, purpose: DatabasePurpose): DatabaseConfig {
  const mode = env.DATABASE_MODE;
  if (mode !== undefined && mode !== "local-dev" && mode !== "managed") {
    throw new DatabaseError("DB_MODE_INVALID");
  }
  if ((mode === undefined && !localEnvironments.has(env.NODE_ENV)) || (mode === "local-dev" && env.NODE_ENV === "production")) {
    throw new DatabaseError("DB_MANAGED_REQUIRED");
  }

  const poolMax = purpose === "migration" ? 1 : optionalInteger(env.DATABASE_POOL_MAX, 50, "DB_POOL_MAX_INVALID");
  const connectTimeout = optionalInteger(env.DATABASE_CONNECT_TIMEOUT_SECONDS, 60, "DB_CONNECT_TIMEOUT_INVALID");
  const idleTimeout = optionalInteger(env.DATABASE_IDLE_TIMEOUT_SECONDS, 600, "DB_IDLE_TIMEOUT_INVALID");

  if (mode !== "managed") {
    return { mode: "local-dev", url: env.DATABASE_URL ?? localUrl, poolMax, connectTimeout, idleTimeout };
  }

  const endpoint = purpose === "migration"
    ? parseManagedEndpoint(env.DATABASE_MIGRATION_URL, "DB_MIGRATION_URL_INVALID")
    : parseManagedEndpoint(env.DATABASE_URL, "DB_RUNTIME_URL_INVALID");
  const caFile = env.DATABASE_TLS_CA_FILE;
  if (!caFile?.trim() || caFile.includes("\0")) throw new DatabaseError("DB_TLS_CA_INVALID");
  if (poolMax === undefined) throw new DatabaseError("DB_POOL_MAX_INVALID");

  return { mode, purpose, endpoint, caFile, poolMax, connectTimeout: connectTimeout ?? 30, idleTimeout: idleTimeout ?? 30 };
}
