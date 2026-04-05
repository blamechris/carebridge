import { router, publicProcedure, mergeRouters } from "./trpc.js";

const healthRouter = router({
  healthCheck: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  }),
});

// Service routers will be imported and merged here as they are created.
// Example:
//   import { authRouter } from "@carebridge/auth";
//   const appRouter = mergeRouters(healthRouter, authRouter, ...);

export const appRouter = mergeRouters(healthRouter);

export type AppRouter = typeof appRouter;
