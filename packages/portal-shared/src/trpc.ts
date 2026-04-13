"use client";

import { createTRPCReact, httpLink } from "@trpc/react-query";
import { createTRPCClient, httpLink as vanillaHttpLink } from "@trpc/client";
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

function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/trpc`
    : "http://localhost:4000/trpc";
}

function authHeaders() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Create links array for the tRPC React provider.
 */
export function getTRPCLinks() {
  return [
    httpLink({
      url: getApiUrl(),
      headers: authHeaders,
    }),
  ];
}

/**
 * Vanilla (non-React) tRPC client for use outside of components (e.g. login page actions).
 */
export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [
    vanillaHttpLink({
      url: getApiUrl(),
      headers: authHeaders,
    }),
  ],
});
