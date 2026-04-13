/**
 * Shared hook to resolve the current patient's record.
 *
 * Uses user.patient_id (set on the users table) for a direct lookup via
 * patients.getById. If the user account has no patient_id linked, the hook
 * returns an explicit `isUnlinked` flag so pages can show an error state
 * instead of silently falling back to another patient's data.
 */

import { useAuth } from "./auth";
import { trpc } from "./trpc";

export function useMyPatientRecord() {
  const { user } = useAuth();

  const hasPatientId = !!user?.patient_id;

  const directQuery = trpc.patients.getById.useQuery(
    { id: user?.patient_id ?? "" },
    { enabled: hasPatientId },
  );

  return {
    patient: hasPatientId ? (directQuery.data ?? null) : null,
    isLoading: hasPatientId ? directQuery.isLoading : false,
    isError: hasPatientId ? directQuery.isError : false,
    /** True when the user account is not linked to any patient record. */
    isUnlinked: !!user && !user.patient_id,
  };
}
