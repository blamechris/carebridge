"use client";

import { useState } from "react";
import { AuthGuard } from "@/lib/auth-guard";

interface Flag {
  id: string;
  severity: "critical" | "warning" | "info";
  patient: string;
  patientId: string;
  summary: string;
  suggestion: string;
  time: string;
  acknowledged: boolean;
}

const initialFlags: Flag[] = [
  {
    id: "flag-1",
    severity: "critical",
    patient: "Maria Santos",
    patientId: "pt-001",
    summary: "Critical lab result: Potassium 6.2 mEq/L",
    suggestion:
      "Recommend STAT ECG and urgent potassium correction protocol. Consider sodium polystyrene sulfonate and reassess in 2 hours.",
    time: "12 min ago",
    acknowledged: false,
  },
  {
    id: "flag-2",
    severity: "warning",
    patient: "James Thompson",
    patientId: "pt-002",
    summary: "Medication interaction detected: Warfarin + new Amiodarone order",
    suggestion:
      "Consider reducing Warfarin dose by 30-50% and schedule INR check in 3 days. Monitor for signs of bleeding.",
    time: "34 min ago",
    acknowledged: false,
  },
  {
    id: "flag-3",
    severity: "info",
    patient: "Aisha Johnson",
    patientId: "pt-003",
    summary: "HbA1c trending up: 7.1% to 7.8% over 6 months",
    suggestion:
      "Consider medication adjustment or endocrinology referral at next visit. Patient may benefit from CGM.",
    time: "1 hr ago",
    acknowledged: false,
  },
  {
    id: "flag-4",
    severity: "warning",
    patient: "Robert Kim",
    patientId: "pt-004",
    summary:
      "Missed follow-up: Post-discharge cardiology appointment overdue by 7 days",
    suggestion:
      "Patient was discharged 14 days ago with instruction to follow up in 7 days. No cardiology appointment has been scheduled.",
    time: "2 hr ago",
    acknowledged: false,
  },
  {
    id: "flag-5",
    severity: "info",
    patient: "Dorothy Williams",
    patientId: "pt-005",
    summary: "Fall risk assessment: MORSE score increased to 55 (high risk)",
    suggestion:
      "Consider physical therapy referral and home safety evaluation. Review current medications for fall-risk contributors.",
    time: "3 hr ago",
    acknowledged: false,
  },
  {
    id: "flag-6",
    severity: "warning",
    patient: "Maria Santos",
    patientId: "pt-001",
    summary: "Blood pressure consistently above target: avg 152/94 over 30 days",
    suggestion:
      "Current antihypertensive regimen may need adjustment. Consider adding or uptitrating medication.",
    time: "5 hr ago",
    acknowledged: false,
  },
];

const severityOrder = { critical: 0, warning: 1, info: 2 };

function InboxContent() {
  const [flags, setFlags] = useState(initialFlags);
  const [filter, setFilter] = useState<"all" | "critical" | "warning" | "info">(
    "all"
  );

  const openFlags = flags.filter((f) => !f.acknowledged);
  const filteredFlags =
    filter === "all"
      ? openFlags
      : openFlags.filter((f) => f.severity === filter);

  const sorted = [...filteredFlags].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  function acknowledge(id: string) {
    setFlags((prev) =>
      prev.map((f) => (f.id === id ? { ...f, acknowledged: true } : f))
    );
  }

  function dismiss(id: string) {
    setFlags((prev) =>
      prev.map((f) => (f.id === id ? { ...f, acknowledged: true } : f))
    );
  }

  const criticalCount = openFlags.filter(
    (f) => f.severity === "critical"
  ).length;
  const warningCount = openFlags.filter(
    (f) => f.severity === "warning"
  ).length;
  const infoCount = openFlags.filter((f) => f.severity === "info").length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">AI Flags Inbox</h1>
        <p className="page-subtitle">
          {openFlags.length} open flag{openFlags.length !== 1 ? "s" : ""}{" "}
          requiring your attention
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
          All ({openFlags.length})
        </button>
        <button
          className={`btn btn-sm ${filter === "critical" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setFilter("critical")}
          style={
            filter !== "critical"
              ? { borderColor: "var(--critical-border)", color: "var(--critical)" }
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
              ? { borderColor: "var(--warning-border)", color: "var(--warning)" }
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
        {sorted.length > 0 ? (
          <div className="flag-list">
            {sorted.map((flag) => (
              <div key={flag.id} className="flag-item">
                <div className="flag-severity">
                  <span className={`badge badge-${flag.severity}`}>
                    {flag.severity.toUpperCase()}
                  </span>
                </div>
                <div className="flag-content">
                  <div className="flag-patient">
                    <a
                      href={`/patients/${flag.patientId}`}
                      className="table-link"
                    >
                      {flag.patient}
                    </a>
                  </div>
                  <div className="flag-summary">{flag.summary}</div>
                  <div className="flag-suggestion">{flag.suggestion}</div>
                  <div className="flag-time">{flag.time}</div>
                </div>
                <div className="flag-actions">
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => acknowledge(flag.id)}
                  >
                    Acknowledge
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => dismiss(flag.id)}
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
