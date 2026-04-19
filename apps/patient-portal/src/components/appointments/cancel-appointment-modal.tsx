"use client";

import { useRef, useState } from "react";
import { modalOverlay, modalCard, btnGhost, inputBase } from "./styles";
import { useModalFocusTrap } from "@/lib/use-modal-focus-trap";

export interface CancelAppointmentModalProps {
  appointmentId: string;
  heading?: string;
  confirmLabel?: string;
  onConfirm: (payload: { appointmentId: string; reason: string }) => void;
  onClose: () => void;
}

export function CancelAppointmentModal({
  appointmentId,
  heading = "Cancel appointment",
  confirmLabel = "Confirm cancel",
  onConfirm,
  onClose,
}: CancelAppointmentModalProps) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const isValid = trimmed.length > 0;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(true, dialogRef, onClose);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    onConfirm({ appointmentId, reason: trimmed });
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-appt-heading"
    >
      <form role="form" aria-label={heading} onSubmit={handleSubmit} style={modalCard}>
        <h2 id="cancel-appt-heading" style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>{heading}</h2>
        <p style={{ margin: "0 0 1rem", color: "#bbb", fontSize: "0.85rem" }}>
          Please tell your care team why you&rsquo;re cancelling. This helps them follow up if you still need care.
        </p>
        <label htmlFor="cancel-reason" style={{ display: "block", marginBottom: 6, fontSize: "0.8rem", color: "#999" }}>
          Reason (required)
        </label>
        <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)}
          rows={4} style={{ ...inputBase, width: "100%", resize: "vertical" }}
          placeholder="e.g., Scheduling conflict, feeling better, travel" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "1rem" }}>
          <button type="button" onClick={onClose} style={btnGhost}>Close</button>
          <button type="submit" disabled={!isValid} style={{
            padding: "8px 16px",
            backgroundColor: isValid ? "#ef4444" : "#333",
            border: "none", borderRadius: 6,
            color: isValid ? "#fff" : "#666",
            cursor: isValid ? "pointer" : "not-allowed",
            fontSize: "0.85rem",
          }}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
