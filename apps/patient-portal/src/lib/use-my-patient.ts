/**
 * Shared hook to resolve the currently-viewed patient's record.
 *
 * For a patient user this is always their own record (user.patient_id).
 * For a family_caregiver user it is whichever linked patient is active in
 * the ActivePatientContext (see src/lib/active-patient.tsx). The full
 * patient record is fetched via patients.getById, which re-runs the server
 * access check on every call — the localStorage-backed "active patient" is
 * UX state only, never an authorisation primitive.
 *
 * `isUnlinked` is true only for patient users whose users.patient_id column
 * has not been populated. Caregivers with zero active relationships surface
 * via `useActivePatient().hasNoPatients` instead.
 */

import { useAuth } from "./auth";
import { trpc } from "./trpc";
import { useActivePatient } from "./active-patient";

export function useMyPatientRecord() {
  const { user } = useAuth();
  const { activePatient } = useActivePatient();

  // For caregivers, the active patient (from the ActivePatient context)
  // supplies the id. Patients fall back to users.patient_id.
  const targetId =
    user?.role === "family_caregiver"
      ? (activePatient?.id ?? null)
      : (user?.patient_id ?? null);

  const hasTarget = !!targetId;

  const directQuery = trpc.patients.getById.useQuery(
    { id: targetId ?? "" },
    { enabled: hasTarget },
  );

  return {
    patient: hasTarget ? (directQuery.data ?? null) : null,
    isLoading: hasTarget ? directQuery.isLoading : false,
    isError: hasTarget ? directQuery.isError : false,
    /**
     * True when a patient-role user has no linked patient record. Caregivers
     * with no active relationships are NOT flagged here — that state is
     * exposed via useActivePatient().hasNoPatients.
     */
    isUnlinked: !!user && user.role === "patient" && !user.patient_id,
  };
}
