"use client";

import { createTRPCReact, httpLink } from "@trpc/react-query";
import { createTRPCClient, httpLink as vanillaHttpLink } from "@trpc/client";
import type { AppRouter } from "@carebridge/api-gateway/src/router.js";

/**
 * React Query-integrated tRPC hooks for use inside components.
 */
export const trpc = createTRPCReact<AppRouter>();

function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/trpc`
    : "http://localhost:4000/trpc";
}

/**
 * Returns the base API URL (without /trpc suffix) for non-tRPC endpoints.
 */
export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
}

/**
 * Create links array for the tRPC React provider.
 *
 * Session credentials are sent via HttpOnly cookie (credentials: "include").
 * The cookie is set by POST /auth/session on login and is immune to XSS.
 */
export function getTRPCLinks() {
  return [
    httpLink({
      url: getApiUrl(),
      fetch(url: RequestInfo | URL, options?: RequestInit) {
        return fetch(url, { ...options, credentials: "include" });
      },
    }),
  ];
}

/**
 * Vanilla (non-React) tRPC client for use outside of components (e.g. login page actions).
 *
 * Session credentials are sent via HttpOnly cookie (credentials: "include").
 */
export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [
    vanillaHttpLink({
      url: getApiUrl(),
      fetch(url: RequestInfo | URL, options?: RequestInit) {
        return fetch(url, { ...options, credentials: "include" });
      },
    }),
  ],
});
