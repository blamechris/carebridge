import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Session cookie name used across the platform.
 */
const COOKIE_NAME = "session";

/**
 * 24 hours in seconds — matches the session TTL in the auth service.
 */
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Build a Set-Cookie header value with proper security flags.
 *
 * Flags:
 * - HttpOnly: prevents JavaScript access (XSS protection)
 * - Secure: only sent over HTTPS (skipped in development)
 * - SameSite=Strict: prevents CSRF
 * - Path=/: cookie available on all routes
 * - Max-Age: matches the 24-hour session TTL
 */
function buildSessionCookie(sessionId: string): string {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Build a Set-Cookie header that clears the session cookie.
 */
function buildClearCookie(): string {
  const isProduction = process.env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=0`,
  ];
  if (isProduction) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Fastify onSend hook that intercepts tRPC login and logout responses
 * to set or clear the session cookie with proper security flags.
 *
 * - On successful login: sets the `session` cookie from the response body's session.id
 * - On successful logout: clears the `session` cookie with Max-Age=0
 */
export async function sessionCookieHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: string,
): Promise<string> {
  const url = request.url;

  // tRPC mutation URLs look like /trpc/login or /trpc/logout
  // They may also have query params, so match with startsWith or regex.
  const isLogin = /\/trpc\/login\b/.test(url);
  const isLogout = /\/trpc\/logout\b/.test(url);

  if (!isLogin && !isLogout) {
    return payload;
  }

  // Only act on successful responses (2xx).
  const statusCode = reply.statusCode;
  if (statusCode < 200 || statusCode >= 300) {
    return payload;
  }

  if (isLogin && typeof payload === "string") {
    try {
      const body = JSON.parse(payload);
      // tRPC wraps results in { result: { data: ... } }
      const sessionId: unknown = body?.result?.data?.session?.id;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        reply.header("Set-Cookie", buildSessionCookie(sessionId));
      }
    } catch {
      // Payload isn't valid JSON or doesn't match expected shape — skip.
    }
  }

  if (isLogout) {
    reply.header("Set-Cookie", buildClearCookie());
  }

  return payload;
}
