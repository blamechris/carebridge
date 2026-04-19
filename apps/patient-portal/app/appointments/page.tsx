"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";
import { AppointmentsPageInner } from "@/components/appointments/appointments-page-inner";
import type { CareTeamProvider, SlotOption, BookPayload } from "@/components/appointments/book-appointment-modal";
import type { AppointmentRow } from "@/components/appointments/appointment-list";

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function AppointmentsPage() {
  const { user, hydrated, isAuthenticated } = useAuth();
  const router = useRouter();
  const utils = trpc.useUtils();

  const { patient: myRecord, isLoading: patientLoading, isUnlinked } = useMyPatientRecord();

  const appointmentsQuery = trpc.scheduling.appointments.listByPatient.useQuery(
    { patientId: myRecord?.id ?? "" }, { enabled: !!myRecord },
  );
  const careTeamQuery = trpc.patients.careTeam.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" }, { enabled: !!myRecord },
  );

  const bookMutation = trpc.scheduling.appointments.create.useMutation({
    onSuccess: () => utils.scheduling.appointments.listByPatient.invalidate(),
  });
  const cancelMutation = trpc.scheduling.appointments.cancel.useMutation({
    onSuccess: () => utils.scheduling.appointments.listByPatient.invalidate(),
  });
  // Atomic reschedule (#892) — single RBAC-checked call replaces the
  // former cancel+create split.
  const rescheduleMutation = trpc.scheduling.appointments.reschedule.useMutation({
    onSuccess: () => utils.scheduling.appointments.listByPatient.invalidate(),
  });

  const loadSlots = useCallback(async (a: { providerId: string; date: string }): Promise<SlotOption[]> => {
    return (await utils.scheduling.schedule.availability.fetch(a)).slots;
  }, [utils]);

  const handleBook = useCallback(
    async (a: BookPayload & { patientId: string }) => { await bookMutation.mutateAsync(a); },
    [bookMutation],
  );
  const handleCancel = useCallback(
    async (a: { appointmentId: string; reason: string }) => { await cancelMutation.mutateAsync(a); },
    [cancelMutation],
  );
  const handleReschedule = useCallback(
    async (a: { appointmentId: string; newStartTime: string; newEndTime: string; reason: string }) => {
      await rescheduleMutation.mutateAsync(a);
    },
    [rescheduleMutation],
  );

  if (!hydrated) return <p style={{ color: "#999" }}>Loading...</p>;
  if (!isAuthenticated) { router.replace("/login"); return null; }
  if (patientLoading) return <p style={{ color: "#999" }}>Loading your record...</p>;
  if (isUnlinked || !myRecord) {
    return (
      <div role="alert" style={{
        backgroundColor: "#7f1d1d", border: "1px solid #ef4444", borderRadius: 8,
        padding: "1.25rem", color: "#fca5a5",
      }}>
        <strong>Account not linked.</strong> Your account is not linked to a patient record. Please contact your care team.
      </div>
    );
  }

  // Map care-team rows to provider options. The `care_team_members` row has
  // no name field, so fall back to role + specialty until a users join is
  // added upstream (tracked in the PR follow-ups).
  const careTeam: CareTeamProvider[] = (careTeamQuery.data ?? []).map((m) => ({
    provider_id: m.provider_id,
    name: m.specialty ? `${capitalize(m.role)} — ${m.specialty}` : capitalize(m.role),
    specialty: m.specialty ?? null,
    role: m.role,
  }));

  const appointments: AppointmentRow[] = (appointmentsQuery.data ?? []).map((a) => ({
    id: a.id, patient_id: a.patient_id, provider_id: a.provider_id,
    appointment_type: a.appointment_type,
    start_time: a.start_time, end_time: a.end_time,
    status: a.status,
    location: a.location ?? null, reason: a.reason ?? null, cancel_reason: a.cancel_reason ?? null,
  }));

  const loading = appointmentsQuery.isLoading || careTeamQuery.isLoading;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <p style={{ margin: 0, color: "#999", fontSize: "0.85rem" }}>Welcome, {user?.name ?? "Patient"}</p>
        <button type="button" onClick={() => router.push("/")} style={{
          padding: "6px 14px", backgroundColor: "transparent", border: "1px solid #444",
          color: "#999", borderRadius: 6, cursor: "pointer", fontSize: "0.8rem",
        }}>
          Dashboard
        </button>
      </div>

      {appointmentsQuery.isError && (
        <p role="alert" style={{ color: "#ef4444" }}>Failed to load appointments. Please try refreshing.</p>
      )}

      {loading ? (
        <p style={{ color: "#999" }}>Loading appointments...</p>
      ) : (
        <AppointmentsPageInner
          patientId={myRecord.id}
          appointments={appointments}
          careTeam={careTeam}
          onLoadSlots={loadSlots}
          onBook={handleBook}
          onCancel={handleCancel}
          onReschedule={handleReschedule}
        />
      )}
    </div>
  );
}
