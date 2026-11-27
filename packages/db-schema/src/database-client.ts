import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import postgres from "postgres";
import { DatabaseError, type DatabaseConfig } from "./database-config.js";

const maxCaBundleBytes = 1024 * 1024;
const closeTimeoutSeconds = 2;

function readCaBundle(path: string): string[] {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxCaBundleBytes) throw new DatabaseError("DB_TLS_CA_INVALID");

      const pem = readFileSync(fd, "utf8");
      const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      if (!certificates) throw new DatabaseError("DB_TLS_CA_INVALID");
      certificates.forEach((certificate) => new X509Certificate(certificate));
      return certificates;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new DatabaseError("DB_TLS_CA_INVALID");
  }
}

function connect(config: DatabaseConfig): postgres.Sql {
  // Server notices can contain application data. Keep them out of driver diagnostics.
  const onnotice = () => {};

  if (config.mode === "local-dev") {
    const options: postgres.Options<{}> = { onnotice };
    if (config.poolMax !== undefined) options.max = config.poolMax;
    if (config.connectTimeout !== undefined) options.connect_timeout = config.connectTimeout;
    if (config.idleTimeout !== undefined) options.idle_timeout = config.idleTimeout;
    return postgres(config.url, options);
  }

  const { hostname, port, user, password, database } = config.endpoint;
  const ssl = {
    ca: readCaBundle(config.caFile),
    rejectUnauthorized: true,
    // Postgres.js omits SNI for IP addresses. Verify the configured endpoint
    // even then, so a certificate needs a matching DNS or IP SAN.
    checkServerIdentity: (_name: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
  };
  // The pinned driver accepts host and port arrays, while its input types list
  // scalar values. Arrays keep IPv6 colons out of its host/port splitter.
  const endpoint = { host: [hostname], port: [port] } as unknown as { host: string; port: number };
  // Pin the defaults that Postgres.js would otherwise source from ambient PG* variables.
  const options = {
    ...endpoint,
    user,
    database,
    password: () => password,
    ssl,
    sslnegotiation: "postgres",
    max: config.poolMax,
    connect_timeout: config.connectTimeout,
    idle_timeout: config.idleTimeout,
    max_lifetime: 3600,
    max_pipeline: 100,
    keep_alive: 60,
    backoff: (attempt: number) => Math.min(3 ** attempt / 100, 20),
    prepare: true,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: "read-write" as const,
    connection: { application_name: `carebridge-${config.purpose}` },
    onnotice,
  };
  return postgres(options);
}

export function createDatabaseClient(config: DatabaseConfig) {
  let sql: postgres.Sql;
  try {
    sql = connect(config);
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("DB_CLIENT_INVALID");
  }

  let closing: Promise<void> | undefined;
  return {
    sql,
    close() {
      return closing ??= sql.end({ timeout: closeTimeoutSeconds }).catch(() => {
        throw new DatabaseError("DB_CLOSE_FAILED");
      });
    },
  };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export async function withDatabaseClient<T>(client: DatabaseClient, work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  let failed = false;
  try {
    return await work(client.sql);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await client.close().catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
