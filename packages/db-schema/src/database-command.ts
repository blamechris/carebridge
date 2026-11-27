import { fileURLToPath } from "node:url";
import { DatabaseError, type DatabaseErrorCode } from "./database-config.js";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function runDatabaseCommand(work: () => Promise<void>, success: string, failureCode: DatabaseErrorCode) {
  void work().then(
    () => process.stdout.write(`${success}\n`, () => process.exit(0)),
    (cause: unknown) => {
      const error = cause instanceof DatabaseError ? cause : new DatabaseError(failureCode);
      process.stderr.write(`${error.code} ${error.message}\n`, () => process.exit(1));
    },
  );
}
