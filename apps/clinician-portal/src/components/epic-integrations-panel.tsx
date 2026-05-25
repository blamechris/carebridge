"use client";

/**
 * Connect-to-Epic integrations panel for the clinician portal (#1182).
 *
 * Renders inside /settings/integrations and provides:
 *   - "Connect to Epic" form: takes an Epic FHIR base URL (`iss`) and
 *     navigates the browser to the api-gateway's GET /auth/epic/authorize
 *     route. The gateway kicks off the SMART App Launch (Standalone)
 *     flow shipped in services/api-gateway/src/routes/epic-auth.ts and
 *     services/epic-connector/src/app-launch/.
 *   - Connection list: queries `epicAuth.getMyConnections` and shows
 *     each linked Epic org with its expiry + last-updated timestamps.
 *   - Disconnect: calls `epicAuth.disconnect` (mutation already shipped
 *     in services/api-gateway/src/routers/epic-auth.ts).
 *
 * All token material stays on the server — the UI only ever sees
 * metadata (org URL, expiry, scopes).
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl } from "@carebridge/portal-shared/trpc";

interface EpicIntegrationsPanelProps {
  /**
   * Override the api-gateway base URL. Tests pass a fake; production
   * resolves through NEXT_PUBLIC_API_URL via `getApiBaseUrl()`.
   */
  apiBaseUrl?: string;
  /**
   * Window-level navigation hook. Defaults to `window.location.assign`.
   * Injected for tests so we can assert the authorize URL without a
   * real navigation.
   */
  navigate?: (url: string) => void;
}

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms);
  return date.toLocaleString();
}

function isExpired(iso: string): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms < Date.now();
}

export function EpicIntegrationsPanel({
  apiBaseUrl,
  navigate,
}: EpicIntegrationsPanelProps = {}) {
  const [iss, setIss] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const connectionsQuery = trpc.epicAuth.getMyConnections.useQuery();
  const utils = trpc.useUtils();
  const disconnect = trpc.epicAuth.disconnect.useMutation({
    onSuccess: () => {
      void utils.epicAuth.getMyConnections.invalidate();
    },
    onError: (err: unknown) => {
      setDisconnectError(
        err instanceof Error ? err.message : "Failed to disconnect",
      );
    },
  });

  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const trimmed = iss.trim();
    if (!trimmed) {
      setSubmitError("Enter your Epic FHIR base URL.");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setSubmitError("Must be a valid URL (https://…/api/FHIR/R4).");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      setSubmitError("Epic FHIR base URL must be HTTPS.");
      return;
    }
    const base = apiBaseUrl ?? getApiBaseUrl();
    const target = `${base}/auth/epic/authorize?iss=${encodeURIComponent(parsed.toString())}&redirect=${encodeURIComponent("/settings/integrations")}`;
    if (navigate) {
      navigate(target);
    } else if (typeof window !== "undefined") {
      window.location.assign(target);
    }
  }

  function handleDisconnect(epicOrgIss: string) {
    setDisconnectError(null);
    disconnect.mutate({ epic_org_iss: epicOrgIss });
  }

  const connections = connectionsQuery.data ?? [];

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      <div className="detail-card-title">Epic (SMART on FHIR)</div>
      <p
        style={{
          fontSize: 13,
          color: "var(--text-secondary)",
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Link your Epic identity to enable single-patient data sync into
        CareBridge. Tokens are stored encrypted on the server — your
        browser never sees them.
      </p>

      <form onSubmit={handleConnect} style={{ marginBottom: 20 }}>
        <label
          htmlFor="epic-iss-input"
          style={{
            display: "block",
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          Epic FHIR base URL
        </label>
        <input
          id="epic-iss-input"
          type="url"
          className="search-input"
          value={iss}
          onChange={(e) => setIss(e.target.value)}
          placeholder="https://fhir.epic.example.com/api/FHIR/R4"
          style={{ marginBottom: 10, width: "100%" }}
        />
        {submitError && (
          <div
            role="alert"
            style={{
              color: "var(--critical)",
              fontSize: 13,
              marginBottom: 10,
            }}
          >
            {submitError}
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-sm">
          Connect to Epic
        </button>
      </form>

      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 8,
        }}
      >
        Linked organisations
      </div>

      {connectionsQuery.isLoading && (
        <div role="status" style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Loading connections...
        </div>
      )}

      {connectionsQuery.isError && (
        <div role="alert" style={{ fontSize: 13, color: "var(--critical)" }}>
          Failed to load Epic connections.
        </div>
      )}

      {!connectionsQuery.isLoading && !connectionsQuery.isError && connections.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          No Epic connections yet.
        </div>
      )}

      {disconnectError && (
        <div
          role="alert"
          style={{
            color: "var(--critical)",
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          {disconnectError}
        </div>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {connections.map((c) => (
          <li
            key={c.id}
            data-testid={`epic-connection-${c.id}`}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 12px",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, wordBreak: "break-all" }}>
                  {c.epic_org_iss}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginTop: 4,
                  }}
                >
                  <span>
                    {isExpired(c.expires_at) ? "Expired " : "Expires "}
                    {formatExpiry(c.expires_at)}
                  </span>
                  <span style={{ margin: "0 6px" }}>·</span>
                  <span>Linked {formatExpiry(c.created_at)}</span>
                </div>
                {c.epic_practitioner_fhir_id && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    Practitioner FHIR id: {c.epic_practitioner_fhir_id}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={`Disconnect ${c.epic_org_iss}`}
                onClick={() => handleDisconnect(c.epic_org_iss)}
                disabled={disconnect.isPending}
              >
                {disconnect.isPending ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
