"use client";

import { useRef } from "react";
import { appointmentTypeLabel, prepInstructionsFor } from "./prep-instructions";
import type { AppointmentRow } from "./appointment-list";
import { modalOverlay, modalCard, DetailRow } from "./styles";
import { useModalFocusTrap } from "@/lib/use-modal-focus-trap";

export interface AppointmentDetailViewProps {
  appointment: AppointmentRow;
  providerName: string;
  onClose: () => void;
}

export function AppointmentDetailView({ appointment, providerName, onClose }: AppointmentDetailViewProps) {
  const start = new Date(appointment.start_time);
  const end = new Date(appointment.end_time);
  const location = appointment.appointment_type === "telehealth"
    ? "Telehealth"
    : appointment.location ?? "Location TBD";

  const timeFmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(true, dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-heading"
    >
      <div style={modalCard}>
        <h2 id="detail-heading" style={{ margin: "0 0 1rem", fontSize: "1.15rem" }}>Appointment details</h2>
        <dl style={{ fontSize: "0.9rem", margin: 0 }}>
          <DetailRow label="Provider" value={providerName} />
          <DetailRow label="Type" value={appointmentTypeLabel(appointment.appointment_type)} />
          <DetailRow label="Date" value={start.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })} />
          <DetailRow label="Time" value={`${timeFmt(start)} – ${timeFmt(end)}`} />
          <DetailRow label="Location" value={location} />
          <DetailRow label="Status" value={appointment.status.replace(/_/g, " ")} />
          {appointment.reason && <DetailRow label="Reason" value={appointment.reason} />}
          {appointment.cancel_reason && <DetailRow label="Cancel reason" value={appointment.cancel_reason} />}
        </dl>
        <h3 style={{ margin: "1.25rem 0 0.5rem", fontSize: "0.95rem" }}>Prep instructions</h3>
        <p style={{ fontSize: "0.85rem", color: "#ccc", lineHeight: 1.5, margin: 0 }}>
          {prepInstructionsFor(appointment.appointment_type)}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button type="button" onClick={onClose} style={{
            padding: "8px 16px", backgroundColor: "#2563eb", border: "none",
            borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: "0.85rem",
          }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
