"use client";

import { createTRPCClient, httpBatchLink } from "@trpc/client";

// Vanilla tRPC client — will be typed once AppRouter is importable from api-gateway
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppRouter = any;

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:4000/trpc",
    }),
  ],
});
