"use client";

/**
 * Per-patient Epic sync card (#1182).
 *
 * Renders on the patient detail page and surfaces:
 *   - "Sync from Epic now" button (admin-gated) — wired to the
 *     `epicSync.triggerSync` mutation shipped in
 *     services/api-gateway/src/routers/epic-sync.ts (incremental mode).
 *   - Per-resource-type sync state widget from
 *     `epicSync.getSyncStatus` — `last_synced_at`, status, error count.
 *
 * Admin gate matches the backend RBAC: only `user.role === "admin"` can
 * trigger sync. Non-admins still see the status widget but the button is
 * hidden.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/lib/auth";

export interface EpicSyncCardProps {
  patientId: string;
  /**
   * Optional: pre-bind the Epic patient FHIR id. The backend can
   * fall back to a stored mapping; passing it explicitly is faster
   * when the launch context is in scope.
   */
  epicPatientFhirId?: string;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function EpicSyncCard({ patientId, epicPatientFhirId }: EpicSyncCardProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const statusQuery = trpc.epicSync.getSyncStatus.useQuery({
    patient_id: patientId,
  });
  const utils = trpc.useUtils();
  const [mutateError, setMutateError] = useState<string | null>(null);
  const [mutateSuccess, setMutateSuccess] = useState<string | null>(null);

  const triggerSync = trpc.epicSync.triggerSync.useMutation({
    onSuccess: () => {
      setMutateError(null);
      setMutateSuccess("Sync enqueued. Status will refresh shortly.");
      void utils.epicSync.getSyncStatus.invalidate({ patient_id: patientId });
    },
    onError: (err: unknown) => {
      setMutateSuccess(null);
      setMutateError(err instanceof Error ? err.message : "Sync failed");
    },
  });

  function handleSyncNow() {
    setMutateError(null);
    setMutateSuccess(null);
    triggerSync.mutate({
      mode: "incremental",
      patient_id: patientId,
      epic_patient_fhir_id: epicPatientFhirId,
    });
  }

  const rows = statusQuery.data ?? [];
  const totalErrors = rows.reduce((sum, r) => sum + (r.error_count ?? 0), 0);
  const mostRecentSync = rows
    .map((r) => r.last_synced_at)
    .filter((t): t is string => Boolean(t))
    .sort()
    .pop();

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      <div
        className="detail-card-title"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>Epic Sync</span>
        {isAdmin && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSyncNow}
            disabled={triggerSync.isPending}
            data-testid="epic-sync-now-button"
          >
            {triggerSync.isPending ? "Enqueuing..." : "Sync from Epic now"}
          </button>
        )}
      </div>

      <div className="detail-row">
        <span className="detail-label">Last synced</span>
        <span className="detail-value">{formatTimestamp(mostRecentSync)}</span>
      </div>
      <div className="detail-row">
        <span className="detail-label">Errors</span>
        <span className="detail-value">
          {totalErrors}
          {totalErrors > 0 && (
            <span
              className="badge badge-critical"
              style={{ marginLeft: 8 }}
              aria-label={`${totalErrors} sync errors`}
            >
              attention
            </span>
          )}
        </span>
      </div>

      {statusQuery.isLoading && (
        <div role="status" style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Loading sync status...
        </div>
      )}

      {statusQuery.isError && (
        <div role="alert" style={{ fontSize: 13, color: "var(--critical)" }}>
          Failed to load Epic sync status.
        </div>
      )}

      {mutateError && (
        <div
          role="alert"
          style={{ color: "var(--critical)", fontSize: 13, marginTop: 8 }}
        >
          {mutateError}
        </div>
      )}
      {mutateSuccess && (
        <div
          role="status"
          aria-live="polite"
          style={{
            color: "var(--text-secondary)",
            fontSize: 13,
            marginTop: 8,
          }}
        >
          {mutateSuccess}
        </div>
      )}

      {rows.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Per-resource breakdown
          </summary>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
            {rows.map((row) => (
              <li
                key={row.resource_type}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span>{row.resource_type}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {row.status} ({row.resources_synced_count} synced
                  {row.error_count > 0 && `, ${row.error_count} errors`})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
