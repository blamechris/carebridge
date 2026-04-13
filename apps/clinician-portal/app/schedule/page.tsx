"use client";

import { useState } from "react";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";

/**
 * Clinician Schedule View.
 *
 * Shows the provider's daily schedule with appointment slots fetched from
 * the scheduling service via tRPC.
 */

interface AppointmentSlot {
  start: string;
  end: string;
  patientId?: string;
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

  const providerId = user?.id ?? "";

  const availabilityQuery = trpc.scheduling.schedule.availability.useQuery(
    { providerId, date: selectedDate },
    { enabled: !!providerId },
  );

  const dayStart = `${selectedDate}T00:00:00.000Z`;
  const dayEnd = `${selectedDate}T23:59:59.999Z`;

  const appointmentsQuery = trpc.scheduling.appointments.listByProvider.useQuery(
    { startDate: dayStart, endDate: dayEnd },
    { enabled: !!providerId },
  );

  const isLoading = availabilityQuery.isLoading || appointmentsQuery.isLoading;
  const isError = availabilityQuery.isError || appointmentsQuery.isError;

  // Merge availability slots with appointment details
  const slots: AppointmentSlot[] = (() => {
    const rawSlots = availabilityQuery.data?.slots ?? [];
    const appts = appointmentsQuery.data ?? [];

    return rawSlots.map((slot) => {
      // Find an appointment overlapping this slot
      const appt = appts.find(
        (a) => a.start_time < slot.end && a.end_time > slot.start && a.status !== "cancelled",
      );

      if (appt) {
        return {
          start: slot.start,
          end: slot.end,
          patientId: appt.patient_id,
          appointmentType: appt.appointment_type,
          reason: appt.reason ?? undefined,
          status: "booked" as const,
        };
      }

      return {
        start: slot.start,
        end: slot.end,
        status: slot.available ? ("available" as const) : ("blocked" as const),
      };
    });
  })();

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

      {isLoading && (
        <div className="empty-state">
          <div className="empty-state-text">Loading schedule...</div>
        </div>
      )}

      {isError && (
        <div className="empty-state">
          <div className="empty-state-text" style={{ color: "#ef4444" }}>
            Failed to load schedule. Please try again.
          </div>
        </div>
      )}

      {!isLoading && !isError && (
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
                      {slot.appointmentType?.replace(/_/g, " ") ?? "Appointment"}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "#999" }}>
                      {slot.reason ? slot.reason : `Patient ${slot.patientId?.slice(0, 8) ?? ""}`}
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
      )}
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
