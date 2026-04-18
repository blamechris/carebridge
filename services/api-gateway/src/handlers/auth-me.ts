import type { User } from "@carebridge/shared-types";

/**
 * Shape of the profile payload returned by GET /auth/me.
 *
 * The endpoint intentionally returns a subset of the User record — no
 * `is_active`, timestamps, or password hash — so the client only receives
 * the fields it needs to render identity/role-dependent UI.
 */
export interface AuthMeProfile {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  specialty: string | undefined;
  department: string | undefined;
  patient_id: string | undefined;
}

/**
 * Narrow shape of the request object the handler depends on. We only need
 * the decorated `user` property populated by `authMiddleware`, so accepting
 * this minimal interface lets tests call the handler without constructing a
 * full Fastify request.
 */
export interface AuthMeRequest {
  user?: Pick<
    User,
    "id" | "email" | "name" | "role" | "specialty" | "department" | "patient_id"
  >;
}

/**
 * Narrow shape of the reply object the handler depends on. Mirrors the
 * subset of the Fastify reply API we use (`code()` + `send()`), so tests
 * can pass in a lightweight mock and we avoid bootstrapping Fastify.
 */
export interface AuthMeReply {
  code(statusCode: number): AuthMeReply;
  send(payload: unknown): AuthMeReply;
}

/**
 * Handler for GET /auth/me.
 *
 * Returns the authenticated user's profile as resolved by the auth
 * middleware (JWT verification + DB lookup). Clients call this on mount
 * to validate the identity stored in localStorage and to detect stale or
 * tampered sessions before rendering any PHI.
 *
 * Extracted as a standalone function so server.ts and the corresponding
 * unit test can share the exact same code path without needing to
 * bootstrap Fastify in tests (issue #820).
 */
export async function handleAuthMe(
  request: AuthMeRequest,
  reply: AuthMeReply,
): Promise<AuthMeProfile | AuthMeReply> {
  if (!request.user) {
    return reply.code(401).send({ error: "Not authenticated" });
  }
  return {
    id: request.user.id,
    email: request.user.email,
    name: request.user.name,
    role: request.user.role,
    specialty: request.user.specialty,
    department: request.user.department,
    patient_id: request.user.patient_id,
  };
}
