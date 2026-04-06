import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import crypto from "node:crypto";

export interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
  sessionId: string | null;
  requestId: string;
}

export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const req = opts.req as unknown as Record<string, unknown>;
  const user = (req.user as User | null) ?? null;
  const sessionId = (req.sessionId as string | null) ?? null;

  return {
    db: getDb(),
    user,
    sessionId,
    requestId: crypto.randomUUID(),
  };
}
