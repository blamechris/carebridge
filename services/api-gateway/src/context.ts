import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { FastifyRequest } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import crypto from "node:crypto";

export interface Context {
  db: ReturnType<typeof getDb>;
  user: User | null;
  sessionId: string | null;
  requestId: string;
  /**
   * Client IP address for HIPAA § 164.312(b) audit trail. Null when the
   * underlying transport cannot resolve one (shouldn't happen for HTTP but
   * guarded defensively). Procedures that write explicit audit_log rows
   * must read this instead of hard-coding "".
   */
  clientIp: string | null;
  /**
   * Set an HTTP response header on the underlying Fastify reply. Available
   * for tRPC procedures that need transport-layer control (e.g.,
   * Cache-Control on FHIR exports). Absent in non-HTTP contexts.
   */
  setHeader?: (name: string, value: string) => void;
}

/**
 * Resolve the client IP for audit logging.
 *
 * Security note: we intentionally prefer Fastify's `request.ip` over manually
 * parsing `x-forwarded-for`. Fastify only trusts the XFF header when
 * `trustProxy` is configured — which the gateway does NOT currently enable
 * (see server.ts). In that mode, `request.ip` is the direct TCP peer,
 * which is what HIPAA auditing actually wants.
 *
 * If a future deployment turns `trustProxy` on (e.g. behind an AWS ALB),
 * Fastify will automatically populate `request.ip` from XFF per its own
 * validation rules — this resolver keeps working without code changes and
 * without opening a spoofing gap where a malicious client could forge XFF
 * against a gateway that has no upstream proxy.
 *
 * Exported for direct unit testing.
 */
export function resolveClientIp(
  req: Pick<FastifyRequest, "ip">,
): string | null {
  const raw = req.ip;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  // Cast to the decorated shape so this file compiles even when the ambient
  // module augmentation (./fastify.d.ts) is not in scope — e.g. when the
  // patient-portal transpiles this package via Next.js transpilePackages.
  const req = opts.req as FastifyRequest & { user?: User; sessionId?: string };
  const user = req.user ?? null;
  const sessionId = req.sessionId ?? null;

  return {
    db: getDb(),
    user,
    sessionId,
    requestId: crypto.randomUUID(),
    clientIp: resolveClientIp(req),
    setHeader: (name: string, value: string) => {
      opts.res.header(name, value);
    },
  };
}
