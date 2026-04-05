import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb } from "@carebridge/db-schema";
import { users, sessions } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";

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

const isDevMode = process.env.NODE_ENV !== "production";

/**
 * Fastify preHandler hook that resolves the current user from either:
 *   1. `x-dev-user-id` header (dev mode only)
 *   2. `Authorization: Bearer <sessionId>` header
 *   3. `session` cookie
 *
 * Attaches the resolved user to `request.user` (or leaves it null).
 */
export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // --- Dev mode shortcut ---
  if (isDevMode) {
    const devUserId = request.headers["x-dev-user-id"] as string | undefined;
    if (devUserId) {
      const devUser = DEV_USERS[devUserId];
      if (devUser) {
        (request as unknown as Record<string, unknown>).user = devUser;
        return;
      }

      // Dev header present but not a hardcoded user -- try the database.
      const db = getDb();
      const rows = await db.select().from(users).where(eq(users.id, devUserId)).limit(1);
      if (rows.length > 0) {
        const row = rows[0]!;
        (request as unknown as Record<string, unknown>).user = {
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role as User["role"],
          specialty: row.specialty ?? undefined,
          department: row.department ?? undefined,
          is_active: row.is_active,
          created_at: row.created_at,
          updated_at: row.updated_at,
        } satisfies User;
        return;
      }
    }
  }

  // --- Resolve session id from header or cookie ---
  let sessionId: string | undefined;

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    sessionId = authHeader.slice(7);
  }

  if (!sessionId) {
    // Simple cookie parsing (no @fastify/cookie dependency needed).
    const cookieHeader = request.headers.cookie ?? "";
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
    if (match) {
      sessionId = match[1];
    }
  }

  if (!sessionId) {
    return; // No credentials -- user stays null.
  }

  // --- Look up session & user in the database ---
  const db = getDb();
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (sessionRows.length === 0) {
    return;
  }

  const session = sessionRows[0]!;

  // Check expiration.
  if (new Date(session.expires_at) < new Date()) {
    return;
  }

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
    _reply.code(401).send({ error: "Session expired" });
    return;
  }

  (request as unknown as Record<string, unknown>).user = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as User["role"],
    specialty: row.specialty ?? undefined,
    department: row.department ?? undefined,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } satisfies User;
}
