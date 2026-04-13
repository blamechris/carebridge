import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Redis from "ioredis";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import { authMiddleware } from "./middleware/auth.js";
import { auditMiddleware } from "./middleware/audit.js";
import { registerNotificationSSE } from "./routes/notifications-sse.js";
import { startBackgroundWorkers } from "./workers.js";

const API_PORT = Number(process.env.API_PORT) || 4000;
const API_HOST = process.env.API_HOST ?? "0.0.0.0";

function createRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
    lazyConnect: true,
    enableOfflineQueue: false,
  });
}

function resolveCorsOrigins(): string[] {
  const isProduction = process.env.NODE_ENV === "production";
  const rawOrigin = process.env.CORS_ORIGIN;

  if (isProduction) {
    if (!rawOrigin) {
      throw new Error(
        "CORS_ORIGIN must be explicitly set in production. " +
          "Refusing to start with a wildcard origin — this would expose all PHI to any requestor.",
      );
    }
    return rawOrigin.split(",").map((o) => o.trim());
  }

  // Development: use CORS_ORIGIN if set, otherwise fall back to local dev origins
  if (rawOrigin) {
    return rawOrigin.split(",").map((o) => o.trim());
  }
  return ["http://localhost:3000", "http://localhost:3001"];
}

async function main() {
  const corsOrigins = resolveCorsOrigins();
  const redisClient = createRedisClient();

  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // --- Plugins ---
  // Security headers. This is a JSON API, not an HTML app, so CSP and COEP
  // are disabled — they only make sense for browser-rendered documents.
  // HSTS is only meaningful over HTTPS, so we gate it on production.
  await server.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts:
      process.env.NODE_ENV === "production"
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
  });

  await server.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  // Register @fastify/cookie so request.cookies is populated and
  // reply.setCookie is available with proper security flags.
  const cookieSecret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && !cookieSecret) {
    throw new Error(
      "SESSION_SECRET must be set in production for signed session cookies.",
    );
  }
  await server.register(cookie, {
    secret: cookieSecret ?? "dev-insecure-cookie-secret-do-not-use-in-prod",
    parseOptions: {},
  });

  // Global rate limit: 100 requests per minute per IP across all API endpoints.
  // Protects PHI endpoints from enumeration and abuse.
  //
  // The auth.login procedure gets a stricter per-IP limit of 5 req/min
  // in production. At ~30 ms/scrypt check, the default would allow
  // ~3300 guesses/second; this cap reduces that to 5 attempts per minute
  // per IP. In development, the login limit is raised to 60 req/min to
  // avoid blocking manual and automated testing.
  const isDev = process.env.NODE_ENV === "development";
  await server.register(rateLimit, {
    global: true,
    max: (req, _key) => {
      if (req.url?.startsWith("/trpc/auth.login") || req.url?.startsWith("/trpc/auth.refreshSession")) {
        return isDev ? 60 : 5;
      }
      return 100;
    },
    timeWindow: "1 minute",
    redis: redisClient,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });

  // --- Hooks ---
  server.addHook("preHandler", authMiddleware);
  server.addHook("onResponse", auditMiddleware);

  // --- tRPC ---
  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  // --- Session cookie endpoints ---
  //
  // The tRPC auth.login procedure lives in a shared package and cannot touch
  // Fastify's reply directly, so the client calls POST /auth/session with the
  // JWT it received from auth.login and we write it into an HttpOnly cookie
  // with the proper security flags. This prevents XSS from reading the
  // session token and blocks CSRF via SameSite=strict.
  const sessionCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };

  server.post<{ Body: { token?: string } }>(
    "/auth/session",
    async (request, reply) => {
      const token = request.body?.token;
      if (!token || typeof token !== "string") {
        return reply.code(400).send({ error: "Missing session token" });
      }
      reply.setCookie("session", token, sessionCookieOptions);
      return { ok: true };
    },
  );

  server.post("/auth/session/clear", async (_request, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });

  // --- SSE notification stream ---
  registerNotificationSSE(server);

  // --- Health check ---
  server.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  });

  // --- Background workers ---
  // Must run before listen() so the session cleanup worker is enforcing the
  // 15-minute idle timeout the moment the gateway starts accepting traffic.
  await startBackgroundWorkers();

  // --- Start ---
  await server.listen({ port: API_PORT, host: API_HOST });
  server.log.info(
    `CareBridge API Gateway listening on http://${API_HOST}:${API_PORT}`,
  );
}

main().catch((err) => {
  console.error("Failed to start API Gateway:", err);
  process.exit(1);
});
