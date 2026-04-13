import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import { users, sessions, auditLog } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { verifyJWT, JWTError } from "@carebridge/auth";

/** Hardcoded dev users for local development without a seeded database. */
const DEV_USERS: Record<string, User> = {
  "dev-admin": {
    id: "dev-admin",
    email: "admin@carebridge.dev",
    name: "Dev Admin",
    role: "admin",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  },
  "dev-physician": {
    id: "dev-physician",
    email: "physician@carebridge.dev",
    name: "Dev Physician",
    role: "physician",
    specialty: "Internal Medicine",
    department: "General",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  },
  "dev-nurse": {
    id: "dev-nurse",
    email: "nurse@carebridge.dev",
    name: "Dev Nurse",
    role: "nurse",
    department: "General",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  },
};

const isDevAuthEnabled =
  process.env.NODE_ENV !== "production" &&
  process.env.CAREBRIDGE_DEV_AUTH === "true";

/**
 * Fastify preHandler hook that resolves the current user from either:
 *   1. `x-dev-user-id` header (local dev only, requires CAREBRIDGE_DEV_AUTH=true)
 *   2. `Authorization: Bearer <sessionId>` header
 *   3. `session` cookie
 *
 * Attaches the resolved user to `request.user` (or leaves it null).
 */
export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // --- Dev mode shortcut (only when CAREBRIDGE_DEV_AUTH=true and non-production) ---
  if (isDevAuthEnabled) {
    const devUserId = request.headers["x-dev-user-id"] as string | undefined;
    if (devUserId) {
      const devUser = DEV_USERS[devUserId];
      if (devUser) {
        (request as unknown as Record<string, unknown>).user = devUser;
        return;
      }
      // Unknown dev user ID — fall through to normal JWT auth rather than
      // performing a live DB lookup with no token, which would allow
      // impersonating any real user without credentials.
    }
  }

  // --- Resolve session id from header or cookie ---
  let sessionId: string | undefined;

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    sessionId = authHeader.slice(7);
  }

  if (!sessionId) {
    // Parsed by @fastify/cookie plugin registered in server.ts.
    const cookies = (request as unknown as { cookies?: Record<string, string> })
      .cookies;
    if (cookies?.session) {
      sessionId = cookies.session;
    }
  }

  if (!sessionId) {
    return; // No credentials -- user stays null.
  }

  // --- Verify JWT signature and extract the internal session UUID ---
  // All tokens issued by the auth service are signed JWTs whose `sid` claim
  // holds the actual sessions.id UUID. We verify the signature here so that
  // tampered or forged tokens are rejected before we touch the database.
  let resolvedSessionId: string;
  try {
    const payload = await verifyJWT(sessionId);
    resolvedSessionId = payload.sid;
  } catch (err) {
    if (err instanceof JWTError) {
      // Invalid or expired token -- treat as unauthenticated.
      return;
    }
    throw err;
  }

  // --- Look up session & user in the database (revocation check) ---
  const db = getDb();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, resolvedSessionId))
    .limit(1);

  if (sessionRows.length === 0) {
    return;
  }

  const session = sessionRows[0]!;

  // Check expiration.
  if (new Date(session.expires_at) < new Date()) {
    // Clean up the expired session from the database.
    await db.delete(sessions).where(eq(sessions.id, resolvedSessionId));
    return;
  }

  // Touch last_active_at so the cleanup worker can detect idle sessions.
  await db
    .update(sessions)
    .set({ last_active_at: new Date().toISOString() })
    .where(eq(sessions.id, resolvedSessionId));

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user_id))
    .limit(1);

  if (userRows.length === 0) {
    return;
  }

  const row = userRows[0]!;

  // Reject deactivated users and clean up their session.
  if (!row.is_active) {
    await db.delete(sessions).where(eq(sessions.id, session.id));

    // Non-blocking audit log for deactivated-user session rejection.
    db.insert(auditLog)
      .values({
        id: crypto.randomUUID(),
        user_id: row.id,
        action: "session_rejected_inactive",
        resource_type: "session",
        resource_id: session.id,
        details: JSON.stringify({
          reason: "User account is deactivated",
          ip_address: request.ip,
        }),
        ip_address: request.ip,
        timestamp: new Date().toISOString(),
      })
      .catch(() => {
        // Audit logging must never block or crash the rejection flow.
      });

    _reply.code(401).send({ error: "Session expired" });
    return;
  }

  const req = request as unknown as Record<string, unknown>;

  req.user = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as User["role"],
    patient_id: row.patient_id ?? undefined,
    specialty: row.specialty ?? undefined,
    department: row.department ?? undefined,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } satisfies User;

  req.sessionId = sessionId;
}
