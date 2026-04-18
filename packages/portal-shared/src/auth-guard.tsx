"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth";

/**
 * Wraps a page component and redirects to /login if not authenticated.
 *
 * Waits for both localStorage hydration AND the `/auth/me` server round-trip
 * to complete before deciding whether the user is authenticated. This ensures
 * a stale or tampered localStorage identity is never briefly displayed.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, hydrated, verifying } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !verifying && !isAuthenticated) {
      router.replace("/login");
    }
  }, [hydrated, verifying, isAuthenticated, router]);

  if (!hydrated || verifying || !isAuthenticated) {
    return (
      <div style={{ padding: 40, color: "var(--text-muted)" }}>
        {!hydrated || verifying ? "Loading..." : "Redirecting to login..."}
      </div>
    );
  }

  return <>{children}</>;
}
