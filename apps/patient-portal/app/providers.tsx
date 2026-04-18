"use client";

import { Providers as SharedProviders } from "@carebridge/portal-shared/providers";
import { ActivePatientProvider } from "@/lib/active-patient";

/**
 * Patient-portal providers:
 *  - SharedProviders sets up tRPC, React Query, and AuthProvider.
 *  - ActivePatientProvider adds the "which patient am I viewing" context on
 *    top (depends on tRPC + auth, so it MUST be nested inside).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SharedProviders>
      <ActivePatientProvider>{children}</ActivePatientProvider>
    </SharedProviders>
  );
}
