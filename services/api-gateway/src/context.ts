import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import crypto from "node:crypto";

export interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
  sessionId: string | null;
  requestId: string;
  /**
   * Set an HTTP response header on the underlying Fastify reply. Available
   * for tRPC procedures that need transport-layer control (e.g.,
   * Cache-Control on FHIR exports). Absent in non-HTTP contexts.
   */
  setHeader?: (name: string, value: string) => void;
}

export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const user = opts.req.user ?? null;
  const sessionId = opts.req.sessionId ?? null;

  return {
    db: getDb(),
    user,
    sessionId,
    requestId: crypto.randomUUID(),
    setHeader: (name: string, value: string) => {
      opts.res.header(name, value);
    },
  };
}
