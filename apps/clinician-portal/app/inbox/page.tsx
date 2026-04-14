"use client";

import { useState } from "react";
import { AuthGuard } from "@/lib/auth-guard";
import { trpc } from "@/lib/trpc";
import {
  FlagActionModal,
  type FlagAction,
  type FlagActionModalFlag,
} from "@/components/flag-action-modal";

type Severity = "critical" | "warning" | "info";

const severityOrder: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function InboxContent() {
  const utils = trpc.useUtils();
  const flagsQuery = trpc.aiOversight.flags.getAllOpen.useQuery();
  const flags = flagsQuery.data ?? [];

  const [filter, setFilter] = useState<"all" | Severity>("all");
  const [activeFlag, setActiveFlag] = useState<FlagActionModalFlag | null>(
    null,
  );
  const [activeAction, setActiveAction] = useState<FlagAction | null>(null);
  const [activePatientId, setActivePatientId] = useState<string | null>(null);

  const [showSuccess, setShowSuccess] = useState(false);

  const onSuccess = async () => {
    setShowSuccess(true);
    await utils.aiOversight.flags.getAllOpen.invalidate();
    if (activePatientId) {
      await utils.aiOversight.flags.getByPatient.invalidate({
        patientId: activePatientId,
      });
      await utils.aiOversight.flags.getOpenCount.invalidate({
        patientId: activePatientId,
      });
    }
    setTimeout(() => {
      setShowSuccess(false);
      setActiveFlag(null);
      setActiveAction(null);
      setActivePatientId(null);
    }, 1200);
  };

  const acknowledgeMutation =
    trpc.aiOversight.flags.acknowledge.useMutation({ onSuccess });
  const resolveMutation =
    trpc.aiOversight.flags.resolve.useMutation({ onSuccess });
  const dismissMutation =
    trpc.aiOversight.flags.dismiss.useMutation({ onSuccess });

  const isSubmitting =
    acknowledgeMutation.isPending ||
    resolveMutation.isPending ||
    dismissMutation.isPending;

  const filteredFlags =
    filter === "all" ? flags : flags.filter((f) => f.severity === filter);

  const sorted = [...filteredFlags].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  const criticalCount = flags.filter((f) => f.severity === "critical").length;
  const warningCount = flags.filter((f) => f.severity === "warning").length;
  const infoCount = flags.filter((f) => f.severity === "info").length;

  function openModal(
    flag: {
      id: string;
      severity: string;
      summary: string;
      suggested_action?: string | null;
      patient_id: string;
    },
    action: FlagAction,
  ) {
    setActiveFlag({
      id: flag.id,
      severity: flag.severity,
      summary: flag.summary,
      suggested_action: flag.suggested_action ?? undefined,
    });
    setActiveAction(action);
    setActivePatientId(flag.patient_id);
  }

  function handleConfirm(reason: string) {
    if (!activeFlag || !activeAction) return;
    if (activeAction === "acknowledge") {
      acknowledgeMutation.mutate({ flagId: activeFlag.id });
    } else if (activeAction === "resolve") {
      resolveMutation.mutate({
        flagId: activeFlag.id,
        resolution_note: reason,
      });
    } else if (activeAction === "dismiss") {
      dismissMutation.mutate({
        flagId: activeFlag.id,
        dismiss_reason: reason,
      });
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">AI Flags Inbox</h1>
        <p className="page-subtitle">
          {flagsQuery.isLoading
            ? "Loading flags..."
            : `${flags.length} open flag${flags.length !== 1 ? "s" : ""} requiring your attention`}
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <button
          className={`btn btn-sm ${filter === "all" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setFilter("all")}
        >
          All ({flags.length})
        </button>
        <button
          className={`btn btn-sm ${filter === "critical" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setFilter("critical")}
          style={
            filter !== "critical"
              ? {
                  borderColor: "var(--critical-border)",
                  color: "var(--critical)",
                }
              : {}
          }
        >
          Critical ({criticalCount})
        </button>
        <button
          className={`btn btn-sm ${filter === "warning" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setFilter("warning")}
          style={
            filter !== "warning"
              ? {
                  borderColor: "var(--warning-border)",
                  color: "var(--warning)",
                }
              : {}
          }
        >
          Warning ({warningCount})
        </button>
        <button
          className={`btn btn-sm ${filter === "info" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setFilter("info")}
          style={
            filter !== "info"
              ? { borderColor: "var(--info-border)", color: "var(--info)" }
              : {}
          }
        >
          Info ({infoCount})
        </button>
      </div>

      <div className="table-container">
        {flagsQuery.isError ? (
          <div className="empty-state">
            <div className="empty-state-text" style={{ color: "var(--critical)" }}>
              Failed to load flags. Is the API running?
            </div>
          </div>
        ) : sorted.length > 0 ? (
          <div
            className="flag-list"
            role="list"
            aria-live="polite"
            aria-label="Open AI flags"
          >
            {sorted.map((flag) => (
              <div key={flag.id} className="flag-item" role="listitem">
                <div className="flag-severity">
                  <span
                    className={`badge badge-${flag.severity}`}
                    role={flag.severity === "critical" ? "alert" : "status"}
                    aria-label={`Severity: ${flag.severity}`}
                  >
                    <span aria-hidden="true">
                      {flag.severity.toUpperCase()}
                    </span>
                    <span className="sr-only">
                      {flag.severity} severity
                    </span>
                  </span>
                </div>
                <div className="flag-content">
                  <div className="flag-patient">
                    <a
                      href={`/patients/${flag.patient_id}`}
                      className="table-link"
                    >
                      Patient {flag.patient_id.slice(0, 8)}
                    </a>
                  </div>
                  <div className="flag-summary">{flag.summary}</div>
                  <div className="flag-suggestion">{flag.suggested_action}</div>
                  <div className="flag-time">
                    {formatRelative(flag.created_at)}
                  </div>
                </div>
                <div className="flag-actions">
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => openModal(flag, "acknowledge")}
                    disabled={isSubmitting}
                  >
                    Acknowledge
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => openModal(flag, "resolve")}
                    disabled={isSubmitting}
                  >
                    Resolve
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => openModal(flag, "dismiss")}
                    disabled={isSubmitting}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">{"\u2713"}</div>
            <div className="empty-state-text">
              {filter === "all"
                ? "All flags have been addressed. Nice work!"
                : `No open ${filter} flags.`}
            </div>
          </div>
        )}
      </div>

      <FlagActionModal
        flag={activeFlag}
        action={activeAction}
        onCancel={() => {
          if (isSubmitting || showSuccess) return;
          setActiveFlag(null);
          setActiveAction(null);
          setActivePatientId(null);
        }}
        onConfirm={handleConfirm}
        isSubmitting={isSubmitting}
        isSuccess={showSuccess}
      />
    </>
  );
}

export default function InboxPage() {
  return (
    <AuthGuard>
      <InboxContent />
    </AuthGuard>
  );
}
