"use client";

/**
 * AppointmentsPageInner — pure coordinator component.
 *
 * Data + mutation side-effects are injected as props so the component is
 * fully testable without tRPC. The page shell wires these to tRPC procs.
 *
 * Reschedule flow (#892): the coordinator collects the cancel reason AND
 * the new slot via the book wizard, then invokes the single-call
 * `onReschedule` prop which maps to the atomic
 * `scheduling.appointments.reschedule` tRPC procedure. This replaces the
 * previous cancel→book split that could leave the patient without an
 * appointment if the second call failed.
 */

import { useMemo, useState } from "react";
import { AppointmentList, type AppointmentRow } from "./appointment-list";
import {
  BookAppointmentModal, type BookPayload,
  type CareTeamProvider, type SlotOption,
} from "./book-appointment-modal";
import { CancelAppointmentModal } from "./cancel-appointment-modal";
import { AppointmentDetailView } from "./appointment-detail-view";

export interface ReschedulePayload {
  appointmentId: string;
  newStartTime: string;
  newEndTime: string;
  reason: string;
}

export interface AppointmentsPageInnerProps {
  patientId: string;
  appointments: AppointmentRow[];
  careTeam: CareTeamProvider[];
  onLoadSlots: (args: { providerId: string; date: string }) => Promise<SlotOption[]>;
  onBook: (args: BookPayload & { patientId: string }) => Promise<void>;
  onCancel: (args: { appointmentId: string; reason: string }) => Promise<void>;
  /**
   * Atomic reschedule (cancel old + book new in one transaction). When
   * omitted, the coordinator falls back to the legacy two-call flow so
   * existing callers keep working during rollout.
   */
  onReschedule?: (args: ReschedulePayload) => Promise<void>;
}

type Mode =
  | { kind: "idle" }
  | { kind: "book" }
  | { kind: "cancel" | "detail"; appointmentId: string }
  | { kind: "reschedule"; appointmentId: string; phase: "reason"; reason?: never }
  | { kind: "reschedule"; appointmentId: string; phase: "slot"; reason: string };

export function AppointmentsPageInner({
  patientId, appointments, careTeam, onLoadSlots, onBook, onCancel, onReschedule,
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
    // In reschedule mode we EITHER stash the reason and advance to the slot
    // picker (atomic path) OR fall back to legacy cancel-then-book.
    if (mode.kind === "reschedule") {
      if (onReschedule) {
        setMode({
          kind: "reschedule",
          appointmentId: args.appointmentId,
          phase: "slot",
          reason: args.reason,
        });
        return;
      }
      try {
        await onCancel(args);
        setMode({ kind: "book" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to cancel appointment");
      }
      return;
    }
    try {
      await onCancel(args);
      setMode({ kind: "idle" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel appointment");
    }
  }

  async function handleBookConfirm(payload: BookPayload) {
    setError(null);
    // Atomic reschedule branch — the reason was collected in the prior
    // cancel-style step; we now run a single `reschedule` call instead of
    // the separate create.
    if (
      mode.kind === "reschedule" &&
      mode.phase === "slot" &&
      onReschedule
    ) {
      try {
        await onReschedule({
          appointmentId: mode.appointmentId,
          newStartTime: payload.startTime,
          newEndTime: payload.endTime,
          reason: mode.reason,
        });
        setMode({ kind: "idle" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to reschedule appointment");
      }
      return;
    }
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
        onReschedule={(id) =>
          setMode({ kind: "reschedule", appointmentId: id, phase: "reason" })
        }
        onViewDetail={(id) => setMode({ kind: "detail", appointmentId: id })}
      />

      {/* Book flow (standalone) AND reschedule slot picker both use the
          BookAppointmentModal; handleBookConfirm branches on `mode` to run
          either the `create` or the atomic `reschedule` call. */}
      {(mode.kind === "book" ||
        (mode.kind === "reschedule" && mode.phase === "slot")) && (
        <BookAppointmentModal
          careTeam={careTeam}
          onLoadSlots={onLoadSlots}
          onConfirm={handleBookConfirm}
          onClose={() => setMode({ kind: "idle" })}
        />
      )}

      {(mode.kind === "cancel" ||
        (mode.kind === "reschedule" && mode.phase === "reason")) &&
        activeAppointment && (
        <CancelAppointmentModal
          appointmentId={activeAppointment.id}
          heading={
            mode.kind === "reschedule" ? "Reschedule appointment" : "Cancel appointment"
          }
          confirmLabel={
            mode.kind === "reschedule" ? "Continue" : "Confirm cancel"
          }
          onConfirm={handleCancelConfirm}
          onClose={() => setMode({ kind: "idle" })}
        />
      )}

      {mode.kind === "detail" && activeAppointment && (
        <AppointmentDetailView appointment={activeAppointment}
          providerName={providerMap[activeAppointment.provider_id] ?? "Provider"}
          onClose={() => setMode({ kind: "idle" })} />
      )}
    </div>
  );
}
