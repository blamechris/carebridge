"use client";

import { useEffect, useRef, useState } from "react";
import {
  APPOINTMENT_TYPES,
  appointmentTypeLabel,
  type AppointmentType,
} from "./prep-instructions";
import { modalOverlay, modalCard, btnPrimary, btnGhost, inputBase, DetailRow } from "./styles";
import { useModalFocusTrap } from "@/lib/use-modal-focus-trap";

export interface CareTeamProvider {
  provider_id: string;
  name: string;
  specialty: string | null;
  role: string;
}

export interface SlotOption { start: string; end: string; available: boolean; }

export interface BookPayload {
  providerId: string;
  appointmentType: AppointmentType;
  startTime: string;
  endTime: string;
}

export interface BookAppointmentModalProps {
  careTeam: CareTeamProvider[];
  onLoadSlots: (args: { providerId: string; date: string }) => Promise<SlotOption[]>;
  onConfirm: (payload: BookPayload) => void;
  onClose: () => void;
}

// Sourced from the canonical `appointmentTypeSchema` enum (#895) so adding a
// new type in `@carebridge/validators` automatically surfaces it in the UI
// — and removing one becomes a compile error elsewhere (PREP_INSTRUCTIONS).
const TYPES: readonly AppointmentType[] = APPOINTMENT_TYPES;

const radioLabel = (selected: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 10,
  padding: "10px 12px", border: "1px solid #2a2a2a",
  borderRadius: 6, cursor: "pointer",
  backgroundColor: selected ? "#1e3a5f" : "transparent",
});

const formatSlot = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export function BookAppointmentModal({ careTeam, onLoadSlots, onConfirm, onClose }: BookAppointmentModalProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [providerId, setProviderId] = useState("");
  const [apptType, setApptType] = useState<AppointmentType | "">("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotOption | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(true, dialogRef, onClose);

  useEffect(() => {
    if (step !== 3 || !providerId || !date) return;
    let cancelled = false;
    setSlotsLoading(true); setSlots(null);
    onLoadSlots({ providerId, date })
      .then((r) => !cancelled && setSlots(r))
      .catch(() => !cancelled && setSlots([]))
      .finally(() => !cancelled && setSlotsLoading(false));
    return () => { cancelled = true; };
  }, [step, providerId, date, onLoadSlots]);

  const provider = careTeam.find((p) => p.provider_id === providerId);
  const canNext = (step === 1 && !!providerId) || (step === 2 && !!apptType) || (step === 3 && !!selectedSlot);

  function confirmBooking() {
    if (!providerId || !apptType || !selectedSlot) return;
    onConfirm({ providerId, appointmentType: apptType, startTime: selectedSlot.start, endTime: selectedSlot.end });
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-heading"
    >
      <div style={modalCard}>
        {step === 1 && (
          <Step heading="Select provider" desc="Choose a provider from your care team.">
            {careTeam.length === 0 ? (
              <p style={{ color: "#ef4444", fontSize: "0.9rem" }}>
                No providers are on your care team yet. Please contact the front desk.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {careTeam.map((p) => (
                  <label key={p.provider_id} style={radioLabel(providerId === p.provider_id)}>
                    <input type="radio" name="provider" value={p.provider_id}
                      checked={providerId === p.provider_id}
                      onChange={() => setProviderId(p.provider_id)} />
                    <span>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      {p.specialty && <span style={{ color: "#999", marginLeft: 8, fontSize: "0.85rem" }}>{p.specialty}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Step>
        )}

        {step === 2 && (
          <Step heading="Appointment type">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {TYPES.map((t) => (
                <label key={t} style={radioLabel(apptType === t)}>
                  <input type="radio" name="apptType" value={t}
                    checked={apptType === t} onChange={() => setApptType(t)} />
                  <span>{appointmentTypeLabel(t)}</span>
                </label>
              ))}
            </div>
          </Step>
        )}

        {step === 3 && (
          <Step heading="Select a time">
            <label htmlFor="slot-date" style={{ display: "block", marginBottom: 6, fontSize: "0.8rem", color: "#999" }}>Date</label>
            <input id="slot-date" type="date" value={date}
              onChange={(e) => { setDate(e.target.value); setSelectedSlot(null); }}
              style={{ ...inputBase, marginBottom: "1rem" }} />
            {date && slotsLoading && <p style={{ color: "#999", fontSize: "0.85rem" }}>Loading slots...</p>}
            {date && !slotsLoading && slots?.length === 0 && (
              <p style={{ color: "#999", fontSize: "0.85rem" }}>No slots available for this date. Try another day.</p>
            )}
            {date && !slotsLoading && slots && slots.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
                {slots.map((s) => {
                  const selected = selectedSlot?.start === s.start;
                  return (
                    <button key={s.start} type="button"
                      data-testid={`slot-option-${s.start}`}
                      disabled={!s.available}
                      onClick={() => setSelectedSlot(s)}
                      style={{
                        padding: "8px",
                        border: `1px solid ${selected ? "#2563eb" : "#2a2a2a"}`,
                        backgroundColor: selected ? "#2563eb" : s.available ? "#1a1a1a" : "#111",
                        color: s.available ? "#ededed" : "#555",
                        borderRadius: 6, cursor: s.available ? "pointer" : "not-allowed", fontSize: "0.85rem",
                      }}>
                      {formatSlot(s.start)}
                    </button>
                  );
                })}
              </div>
            )}
          </Step>
        )}

        {step === 4 && selectedSlot && provider && apptType && (
          <Step heading="Confirm booking">
            <dl style={{ fontSize: "0.9rem", margin: 0 }}>
              <DetailRow label="Provider" value={provider.name} />
              <DetailRow label="Type" value={appointmentTypeLabel(apptType)} />
              <DetailRow label="Date" value={new Date(selectedSlot.start).toLocaleDateString()} />
              <DetailRow label="Time" value={`${formatSlot(selectedSlot.start)} – ${formatSlot(selectedSlot.end)}`} />
            </dl>
          </Step>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button type="button" onClick={onClose} style={btnGhost}>Close</button>
          {step > 1 && (
            <button type="button" onClick={() => setStep((p) => (p > 1 ? ((p - 1) as 1 | 2 | 3 | 4) : p))} style={btnGhost}>Back</button>
          )}
          {step < 4 && (
            <button type="button" disabled={!canNext}
              onClick={() => canNext && setStep((p) => (p < 4 ? ((p + 1) as 1 | 2 | 3 | 4) : p))}
              style={btnPrimary(canNext)}>Next</button>
          )}
          {step === 4 && (
            <button type="button" onClick={confirmBooking} style={btnPrimary(true)}>Confirm</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ heading, desc, children }: { heading: string; desc?: string; children: React.ReactNode }) {
  return (
    <>
      <h2 id="book-heading" style={{ margin: "0 0 0.75rem", fontSize: "1.1rem" }}>{heading}</h2>
      {desc && <p style={{ margin: "0 0 1rem", color: "#999", fontSize: "0.85rem" }}>{desc}</p>}
      {children}
    </>
  );
}
