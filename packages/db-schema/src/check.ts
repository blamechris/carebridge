import { createDatabaseClient } from "./database-client.js";
import { checkDatabase, resolveExpectedRole } from "./database-check.js";
import { runDatabaseCommand } from "./database-command.js";
import { resolveDatabaseConfig } from "./database-config.js";

runDatabaseCommand(async () => {
  const config = resolveDatabaseConfig(process.env, "runtime");
  const expectedRole = resolveExpectedRole(process.env);
  const deadlineMs = ((config.connectTimeout ?? 30) + 10) * 1000;
  await checkDatabase(createDatabaseClient(config), expectedRole, deadlineMs);
}, "DB_CHECK_OK", "DB_CHECK_FAILED");
