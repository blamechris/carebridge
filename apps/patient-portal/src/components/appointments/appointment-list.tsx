"use client";

import { useState } from "react";
import { appointmentTypeLabel } from "./prep-instructions.js";
import { btnRowSmall } from "./styles.js";

export interface AppointmentRow {
  id: string;
  patient_id: string;
  provider_id: string;
  appointment_type: string;
  start_time: string;
  end_time: string;
  status: string;
  location: string | null;
  reason: string | null;
  cancel_reason: string | null;
}

export interface AppointmentListProps {
  appointments: AppointmentRow[];
  /** Map of provider_id -> display name. Unknown IDs fall back to "Provider". */
  providerMap: Record<string, string>;
  onCancel: (appointmentId: string) => void;
  onReschedule: (appointmentId: string) => void;
  onViewDetail: (appointmentId: string) => void;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function locationLabel(row: AppointmentRow): string {
  if (row.appointment_type === "telehealth") return "Telehealth";
  return row.location ?? "Location TBD";
}

function isUpcoming(row: AppointmentRow): boolean {
  if (["cancelled", "completed", "no_show"].includes(row.status)) return false;
  return new Date(row.end_time).getTime() >= Date.now();
}

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  scheduled: { label: "Scheduled", color: "#3b82f6" },
  confirmed: { label: "Confirmed", color: "#22c55e" },
  checked_in: { label: "Checked in", color: "#22c55e" },
  completed: { label: "Completed", color: "#22c55e" },
  cancelled: { label: "Cancelled", color: "#ef4444" },
  no_show: { label: "No show", color: "#ef4444" },
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.6fr 1.4fr 1fr 1fr auto",
  gap: 16,
  alignItems: "center",
  padding: "12px 16px",
  backgroundColor: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 8,
  marginBottom: 8,
};

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  backgroundColor: active ? "#2563eb" : "transparent",
  border: `1px solid ${active ? "#2563eb" : "#2a2a2a"}`,
  color: active ? "#fff" : "#999",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
});

export function AppointmentList({
  appointments, providerMap, onCancel, onReschedule, onViewDetail,
}: AppointmentListProps) {
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");

  const upcoming = appointments.filter(isUpcoming)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const past = appointments.filter((a) => !isUpcoming(a))
    .sort((a, b) => b.start_time.localeCompare(a.start_time));
  const rows = tab === "upcoming" ? upcoming : past;

  return (
    <div>
      <div role="tablist" aria-label="Appointments" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button role="tab" aria-selected={tab === "upcoming"} onClick={() => setTab("upcoming")} style={tabBtn(tab === "upcoming")}>
          Upcoming ({upcoming.length})
        </button>
        <button role="tab" aria-selected={tab === "past"} onClick={() => setTab("past")} style={tabBtn(tab === "past")}>
          Past ({past.length})
        </button>
      </div>

      {rows.length === 0 && (
        <p style={{ color: "#999", fontSize: "0.9rem" }}>
          {tab === "upcoming" ? "No upcoming appointments." : "No past appointments."}
        </p>
      )}

      {rows.map((row) => {
        const badge = STATUS_BADGE[row.status] ?? { label: row.status, color: "#999" };
        const showActions = tab === "upcoming";
        return (
          <div key={row.id} data-testid={`appointment-row-${row.id}`} style={rowStyle}>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{formatDateTime(row.start_time)}</div>
              <div style={{ fontSize: "0.75rem", color: "#999" }}>{appointmentTypeLabel(row.appointment_type)}</div>
            </div>
            <div style={{ fontSize: "0.9rem" }}>{providerMap[row.provider_id] ?? "Provider"}</div>
            <div style={{ fontSize: "0.85rem", color: "#bbb" }}>{locationLabel(row)}</div>
            <div>
              <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, backgroundColor: `${badge.color}20`, color: badge.color, fontSize: "0.75rem" }}>
                {badge.label}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => onViewDetail(row.id)} style={btnRowSmall}>View details</button>
              {showActions && (
                <>
                  <button onClick={() => onReschedule(row.id)} style={btnRowSmall}>Reschedule</button>
                  <button onClick={() => onCancel(row.id)} style={{ ...btnRowSmall, borderColor: "#7f1d1d", color: "#fca5a5" }}>Cancel</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
