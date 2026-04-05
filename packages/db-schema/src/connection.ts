import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    const connectionString = process.env.DATABASE_URL
      ?? "postgresql://carebridge:carebridge_dev@localhost:5432/carebridge";
    const client = postgres(connectionString);
    db = drizzle(client, { schema });
  }
  return db;
}
