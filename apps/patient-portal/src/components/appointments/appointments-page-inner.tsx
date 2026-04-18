"use client";

/**
 * AppointmentsPageInner — pure coordinator component.
 *
 * Data + mutation side-effects are injected as props so the component is
 * fully testable without tRPC. The page shell wires these to tRPC procs.
 */

import { useMemo, useState } from "react";
import { AppointmentList, type AppointmentRow } from "./appointment-list.js";
import {
  BookAppointmentModal, type BookPayload,
  type CareTeamProvider, type SlotOption,
} from "./book-appointment-modal.js";
import { CancelAppointmentModal } from "./cancel-appointment-modal.js";
import { AppointmentDetailView } from "./appointment-detail-view.js";

export interface AppointmentsPageInnerProps {
  patientId: string;
  appointments: AppointmentRow[];
  careTeam: CareTeamProvider[];
  onLoadSlots: (args: { providerId: string; date: string }) => Promise<SlotOption[]>;
  onBook: (args: BookPayload & { patientId: string }) => Promise<void>;
  onCancel: (args: { appointmentId: string; reason: string }) => Promise<void>;
}

type Mode =
  | { kind: "idle" }
  | { kind: "book" }
  | { kind: "cancel" | "reschedule" | "detail"; appointmentId: string };

export function AppointmentsPageInner({
  patientId, appointments, careTeam, onLoadSlots, onBook, onCancel,
}: AppointmentsPageInnerProps) {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const providerMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of careTeam) map[p.provider_id] = p.name;
    return map;
  }, [careTeam]);

  const activeAppointment = mode.kind !== "idle" && mode.kind !== "book"
    ? appointments.find((a) => a.id === mode.appointmentId) ?? null
    : null;

  async function handleCancelConfirm(args: { appointmentId: string; reason: string }) {
    setError(null);
    const wasReschedule = mode.kind === "reschedule";
    try {
      await onCancel(args);
      setMode(wasReschedule ? { kind: "book" } : { kind: "idle" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel appointment");
    }
  }

  async function handleBookConfirm(payload: BookPayload) {
    setError(null);
    try {
      await onBook({ ...payload, patientId });
      setMode({ kind: "idle" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to book appointment");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem" }}>My appointments</h2>
        <button type="button" onClick={() => setMode({ kind: "book" })} style={{
          padding: "8px 16px", backgroundColor: "#2563eb", border: "none",
          borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: "0.85rem",
        }}>
          Book appointment
        </button>
      </div>

      {error && (
        <div role="alert" style={{
          backgroundColor: "#7f1d1d", border: "1px solid #ef4444", borderRadius: 8,
          padding: "0.75rem 1rem", color: "#fca5a5", marginBottom: "1rem", fontSize: "0.85rem",
        }}>
          {error}
        </div>
      )}

      <AppointmentList
        appointments={appointments}
        providerMap={providerMap}
        onCancel={(id) => setMode({ kind: "cancel", appointmentId: id })}
        onReschedule={(id) => setMode({ kind: "reschedule", appointmentId: id })}
        onViewDetail={(id) => setMode({ kind: "detail", appointmentId: id })}
      />

      {mode.kind === "book" && (
        <BookAppointmentModal careTeam={careTeam} onLoadSlots={onLoadSlots}
          onConfirm={handleBookConfirm} onClose={() => setMode({ kind: "idle" })} />
      )}

      {(mode.kind === "cancel" || mode.kind === "reschedule") && activeAppointment && (
        <CancelAppointmentModal appointmentId={activeAppointment.id}
          onConfirm={handleCancelConfirm} onClose={() => setMode({ kind: "idle" })} />
      )}

      {mode.kind === "detail" && activeAppointment && (
        <AppointmentDetailView appointment={activeAppointment}
          providerName={providerMap[activeAppointment.provider_id] ?? "Provider"}
          onClose={() => setMode({ kind: "idle" })} />
      )}
    </div>
  );
}
