"use client";

/**
 * Epic launch-context banner (#1182, hardened in #1186).
 *
 * Shown at the top of the clinician portal when the user has arrived
 * via the SMART App Launch callback. The callback in
 * services/api-gateway/src/routes/epic-auth.ts appends
 * `?epic_patient=<fhir-id>&epic_encounter=<fhir-id>` to the configured
 * post-launch redirect.
 *
 * SECURITY (#1186): The banner does NOT trust URL params on their own —
 * server-confirmed launch context (`epicAuth.getLaunchContext`) is the
 * sole source of truth for the rendered patient/org/encounter values.
 * URL params can be spoofed by anyone with a clinician-facing link
 * (e.g. `?epic_patient=fake-id`), so we:
 *
 *   1. Always issue the `getLaunchContext` query (regardless of URL).
 *   2. Render null while the query is in flight, on error, or when the
 *      server returns null (no valid Epic connection).
 *   3. When server context is present AND URL params are present, they
 *      MUST match — otherwise we hide the banner and emit a console.warn
 *      (a tamper signal worth surfacing in browser logs).
 *   4. When server context is present AND no URL params are present,
 *      we still render — this preserves the original clinical-safety
 *      intent for the "session-store row outlived the URL" case (e.g.
 *      a deep-link navigation that dropped the search params).
 *   5. The displayed FHIR ids/org are taken from the SERVER payload,
 *      never the URL.
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

  const urlEpicPatient = searchParams?.get("epic_patient") ?? null;
  const urlEpicEncounter = searchParams?.get("epic_encounter") ?? null;

  // Always query the server. URL params are a hint at best — the server
  // is the source of truth for whether a launch context is real and what
  // the actual patient/org/encounter ids are.
  const contextQuery = trpc.epicAuth.getLaunchContext.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Sessionstorage suppression — only access on the client after mount.
  // Keyed on the server-confirmed patient id so spoofed URLs can't
  // pre-suppress a future genuine launch.
  const ctx = contextQuery.data ?? null;
  const serverPatient = ctx?.epic_patient_fhir_id ?? null;

  const [suppressed, setSuppressed] = useState(false);
  useEffect(() => {
    if (!serverPatient) return;
    try {
      const ss = storage ?? globalThis.sessionStorage;
      if (ss?.getItem(SUPPRESS_KEY) === serverPatient) {
        setSuppressed(true);
      }
    } catch {
      // sessionStorage unavailable (SSR, blocked) — leave un-suppressed.
    }
  }, [serverPatient, storage]);

  // Hide while loading or on error — better to flash nothing than to
  // flash an unverified URL-derived banner.
  if (contextQuery.isLoading || contextQuery.isError) return null;

  // Server says no valid Epic connection → render nothing, even if the
  // URL claims otherwise. This is the anti-spoofing gate.
  if (!ctx) return null;

  if (suppressed) return null;

  // If the URL has params, they MUST agree with the server. If they
  // don't, someone tampered — hide the banner and log a warning so it
  // surfaces in browser dev tools / error-reporting pipelines.
  if (urlEpicPatient && urlEpicPatient !== ctx.epic_patient_fhir_id) {
    // eslint-disable-next-line no-console
    console.warn(
      "[epic-launch-banner] URL epic_patient does not match server launch context; hiding banner.",
    );
    return null;
  }
  if (
    urlEpicEncounter &&
    ctx.launch_encounter_fhir_id &&
    urlEpicEncounter !== ctx.launch_encounter_fhir_id
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      "[epic-launch-banner] URL epic_encounter does not match server launch context; hiding banner.",
    );
    return null;
  }

  // From here on, render exclusively from server values.
  const orgLabel = ctx.epic_org_iss ?? "Epic";
  const patientId = ctx.epic_patient_fhir_id;
  const encounterId = ctx.launch_encounter_fhir_id;

  function handleSwitchToPortal() {
    try {
      const ss = storage ?? globalThis.sessionStorage;
      if (patientId) ss?.setItem(SUPPRESS_KEY, patientId);
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
          Viewing Epic patient FHIR id <code>{patientId}</code>
          {encounterId && (
            <>
              {" "}
              · Encounter <code>{encounterId}</code>
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
