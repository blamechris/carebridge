"use client";

import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { createTRPCClient, httpBatchLink as vanillaHttpBatchLink } from "@trpc/client";
import type { AppRouter } from "@carebridge/api-gateway/src/router.js";

/**
 * React Query-integrated tRPC hooks for use inside components.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Returns the session token stored in localStorage (if any).
 */
function getSessionToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return localStorage.getItem("carebridge_session") ?? undefined;
}

/**
 * Create links array for the tRPC React provider.
 */
export function getTRPCLinks() {
  return [
    httpBatchLink({
      url: "http://localhost:4000/trpc",
      headers() {
        const token = getSessionToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ];
}

/**
 * Vanilla (non-React) tRPC client for use outside of components (e.g. login page actions).
 */
export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [
    vanillaHttpBatchLink({
      url: "http://localhost:4000/trpc",
      headers() {
        const token = getSessionToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
