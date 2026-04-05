import Fastify from "fastify";
import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";
import { authMiddleware } from "./middleware/auth.js";
import { auditMiddleware } from "./middleware/audit.js";
import { sessionCookieHook } from "./middleware/session-cookie.js";

const API_PORT = Number(process.env.API_PORT) || 4000;
const API_HOST = process.env.API_HOST ?? "0.0.0.0";

async function main() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // --- Plugins ---
  const corsOrigin = process.env.CORS_ORIGIN
    ?? (process.env.NODE_ENV === "production"
      ? false
      : ["http://localhost:3000", "http://localhost:3001"]);

  await server.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  // --- Hooks ---
  server.addHook("preHandler", authMiddleware);
  server.addHook("onSend", sessionCookieHook);
  server.addHook("onResponse", auditMiddleware);

  // --- tRPC ---
  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  // --- Health check ---
  server.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  });

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
