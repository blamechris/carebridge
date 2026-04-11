/**
 * Shared hook to resolve the current patient's record.
 *
 * Uses user.patient_id (set on the users table) instead of the fragile
 * name-match + fallback-to-first pattern that could expose PHI.
 *
 * Falls back to patients.getById if patient_id is available on the user,
 * otherwise falls back to name-match (legacy compat) but WITHOUT the
 * dangerous data[0] fallback.
 */

import { useAuth } from "./auth";
import { trpc } from "./trpc";

export function useMyPatientRecord() {
  const { user } = useAuth();

  // Preferred path: direct lookup by patient_id
  const directQuery = trpc.patients.getById.useQuery(
    { id: user?.patient_id ?? "" },
    { enabled: !!user?.patient_id },
  );

  // Legacy fallback: find by name (without dangerous data[0] fallback)
  const listQuery = trpc.patients.list.useQuery(
    undefined,
    { enabled: !!user && !user.patient_id },
  );

  if (user?.patient_id && directQuery.data) {
    return {
      patient: directQuery.data,
      isLoading: directQuery.isLoading,
      isError: directQuery.isError,
    };
  }

  // Legacy name-match — NO fallback to first record
  const nameMatch = listQuery.data?.find((p) => p.name === user?.name) ?? null;

  return {
    patient: nameMatch,
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
  };
}
