"use client";

import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { createTRPCClient, httpBatchLink as vanillaHttpBatchLink } from "@trpc/client";
import type { AppRouter } from "@carebridge/api-gateway/src/router.js";

export const trpc = createTRPCReact<AppRouter>();

function getSessionToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return localStorage.getItem("carebridge_session") ?? undefined;
}

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
