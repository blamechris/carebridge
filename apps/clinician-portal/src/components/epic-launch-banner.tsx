"use client";

/**
 * Epic launch-context banner (#1182).
 *
 * Shown at the top of the clinician portal when the user has arrived
 * via the SMART App Launch callback. The callback in
 * services/api-gateway/src/routes/epic-auth.ts appends
 * `?epic_patient=<fhir-id>&epic_encounter=<fhir-id>` to the configured
 * post-launch redirect, so the SPA detects launch-mode by looking for
 * those query params and cross-checks against `epicAuth.getLaunchContext`
 * (which only returns a non-null payload when the most-recent connection
 * is still within its access-token TTL).
 *
 * The banner offers a "Switch to portal mode" action that strips the
 * launch markers from the URL and sets a sessionStorage suppression flag
 * so subsequent navigations on the same tab don't re-show the banner.
 * Closing the tab clears the flag — the next deep-link from Epic will
 * re-show it.
 */

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";

const SUPPRESS_KEY = "carebridge_epic_launch_suppressed";

export interface EpicLaunchBannerProps {
  /** Override sessionStorage for tests. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export function EpicLaunchBanner({ storage }: EpicLaunchBannerProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const epicPatient = searchParams?.get("epic_patient") ?? null;
  const epicEncounter = searchParams?.get("epic_encounter") ?? null;
  const inLaunchContext = Boolean(epicPatient);

  // Sessionstorage suppression — only access on the client after mount.
  const [suppressed, setSuppressed] = useState(false);
  useEffect(() => {
    if (!inLaunchContext) return;
    try {
      const ss = storage ?? globalThis.sessionStorage;
      if (ss?.getItem(SUPPRESS_KEY) === epicPatient) {
        setSuppressed(true);
      }
    } catch {
      // sessionStorage unavailable (SSR, blocked) — leave un-suppressed.
    }
  }, [inLaunchContext, epicPatient, storage]);

  // Pull the full launch context (org iss, expiry) only when the URL
  // claims we just launched — avoids an unnecessary network round-trip
  // for every page view.
  const contextQuery = trpc.epicAuth.getLaunchContext.useQuery(undefined, {
    enabled: inLaunchContext && !suppressed,
    staleTime: 60_000,
  });

  if (!inLaunchContext || suppressed) return null;

  // Optional: when the URL says we launched but the server says no valid
  // connection, still show the banner using URL data (the connection
  // may have just expired between the redirect and now — clinically it's
  // safer to surface the patient context than to silently drop it).
  const ctx = contextQuery.data ?? null;
  const orgLabel = ctx?.epic_org_iss ?? "Epic";

  function handleSwitchToPortal() {
    try {
      const ss = storage ?? globalThis.sessionStorage;
      if (epicPatient) ss?.setItem(SUPPRESS_KEY, epicPatient);
    } catch {
      // Best-effort.
    }
    // Strip the launch markers but preserve any other query params the
    // user navigated to in the meantime.
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.delete("epic_patient");
    next.delete("epic_encounter");
    const qs = next.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    router.replace(url);
    setSuppressed(true);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="epic-launch-banner"
      style={{
        background: "var(--info-bg, #eef6ff)",
        border: "1px solid var(--info-border, #2563eb)",
        borderRadius: 6,
        padding: "10px 14px",
        margin: "0 0 16px 0",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          Launched from {orgLabel}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Viewing Epic patient FHIR id <code>{epicPatient}</code>
          {epicEncounter && (
            <>
              {" "}
              · Encounter <code>{epicEncounter}</code>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleSwitchToPortal}
        aria-label="Switch to portal mode and clear Epic launch context"
      >
        Switch to portal mode
      </button>
    </div>
  );
}
