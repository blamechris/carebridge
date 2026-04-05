import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import crypto from "node:crypto";

export interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
  requestId: string;
}

export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const user = ((opts.req as unknown as Record<string, unknown>).user as User | null) ?? null;

  return {
    db: getDb(),
    user,
    requestId: crypto.randomUUID(),
  };
}
