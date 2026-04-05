"use client";

// Providers wrapper — tRPC client is initialized in @/lib/trpc
// React Query provider will be added when we wire up live data
export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
