"use client";

import { useState } from "react";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";

/**
 * Clinician Schedule View.
 *
 * Shows the provider's daily schedule with appointment slots.
 * Depends on the scheduling service (PR #349 / issue #330) being merged
 * and registered in the api-gateway before full tRPC integration.
 *
 * Until then, this provides the UI shell with static placeholder data.
 */

interface AppointmentSlot {
  start: string;
  end: string;
  patientName?: string;
  appointmentType?: string;
  reason?: string;
  status: "available" | "booked" | "blocked";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusColor(status: string): string {
  switch (status) {
    case "available": return "#22c55e";
    case "booked": return "#3b82f6";
    case "blocked": return "#666";
    default: return "#666";
  }
}

function ScheduleContent() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split("T")[0];
  });

  // Placeholder slots — will be replaced with tRPC query once scheduling service is merged
  const slots: AppointmentSlot[] = [
    { start: `${selectedDate}T09:00:00.000Z`, end: `${selectedDate}T09:30:00.000Z`, status: "available" },
    { start: `${selectedDate}T09:30:00.000Z`, end: `${selectedDate}T10:00:00.000Z`, status: "available" },
    { start: `${selectedDate}T10:00:00.000Z`, end: `${selectedDate}T10:30:00.000Z`, patientName: "Placeholder", appointmentType: "follow_up", reason: "Post-treatment check", status: "booked" },
    { start: `${selectedDate}T10:30:00.000Z`, end: `${selectedDate}T11:00:00.000Z`, status: "available" },
    { start: `${selectedDate}T11:00:00.000Z`, end: `${selectedDate}T11:30:00.000Z`, status: "blocked" },
    { start: `${selectedDate}T11:30:00.000Z`, end: `${selectedDate}T12:00:00.000Z`, status: "available" },
    { start: `${selectedDate}T13:00:00.000Z`, end: `${selectedDate}T13:30:00.000Z`, status: "available" },
    { start: `${selectedDate}T13:30:00.000Z`, end: `${selectedDate}T14:00:00.000Z`, status: "available" },
  ];

  function navigateDate(delta: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);
    setSelectedDate(d.toISOString().split("T")[0]);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">My Schedule</h1>
        <p className="page-subtitle">{user?.name ?? "Provider"}</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigateDate(-1)}
        >
          &larr; Previous
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          style={{
            backgroundColor: "#1a1a1a",
            border: "1px solid #333",
            color: "#ededed",
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: "0.9rem",
          }}
        />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigateDate(1)}
        >
          Next &rarr;
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setSelectedDate(new Date().toISOString().split("T")[0])}
          style={{ marginLeft: 8 }}
        >
          Today
        </button>
      </div>

      <div className="table-container">
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {slots.map((slot, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "10px 16px",
                backgroundColor: slot.status === "booked" ? "#1e3a5f" : slot.status === "blocked" ? "#1a1a1a" : "#111",
                borderLeft: `3px solid ${statusColor(slot.status)}`,
                borderRadius: 4,
              }}
            >
              <div style={{ width: 140, fontSize: "0.85rem", color: "#999" }}>
                {formatTime(slot.start)} — {formatTime(slot.end)}
              </div>

              {slot.status === "booked" && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                    {slot.patientName}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#999" }}>
                    {slot.appointmentType?.replace(/_/g, " ")} {slot.reason ? `— ${slot.reason}` : ""}
                  </div>
                </div>
              )}

              {slot.status === "available" && (
                <div style={{ flex: 1, fontSize: "0.85rem", color: "#22c55e" }}>
                  Available
                </div>
              )}

              {slot.status === "blocked" && (
                <div style={{ flex: 1, fontSize: "0.85rem", color: "#666", fontStyle: "italic" }}>
                  Blocked
                </div>
              )}
            </div>
          ))}
        </div>

        {slots.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-text">No schedule configured for this day.</div>
          </div>
        )}
      </div>

      <p style={{ color: "#666", fontSize: "0.75rem", marginTop: 16 }}>
        Schedule integration pending — connect to scheduling service for live data.
      </p>
    </>
  );
}

export default function SchedulePage() {
  return (
    <AuthGuard>
      <ScheduleContent />
    </AuthGuard>
  );
}
