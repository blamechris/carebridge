import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDatabaseClient, withDatabaseClient } from "./database-client.js";
import { migrationsFolder, runDatabaseCommand } from "./database-command.js";
import { resolveDatabaseConfig } from "./database-config.js";

runDatabaseCommand(async () => {
  const client = createDatabaseClient(resolveDatabaseConfig(process.env, "migration"));
  await withDatabaseClient(client, (sql) => migrate(drizzle(sql), { migrationsFolder }));
}, "DB_MIGRATION_OK", "DB_MIGRATION_FAILED");
