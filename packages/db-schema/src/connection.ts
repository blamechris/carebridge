import { drizzle } from "drizzle-orm/postgres-js";
import { createDatabaseClient } from "./database-client.js";
import { resolveDatabaseConfig } from "./database-config.js";
import * as schema from "./schema/index.js";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    const { sql } = createDatabaseClient(resolveDatabaseConfig(process.env, "runtime"));
    db = drizzle(sql, { schema });
  }
  return db;
}
