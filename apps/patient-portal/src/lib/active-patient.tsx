"use client";

/**
 * Active-patient context for the patient portal.
 *
 * Resolves "which patient am I currently viewing" for the logged-in user:
 *  - patient role  → themselves (the only option).
 *  - family_caregiver → a selection from the patients they are linked to.
 *
 * The selection is persisted in localStorage under `ACTIVE_PATIENT_STORAGE_KEY`
 * so it survives page reloads. This is UX convenience only — every server
 * read re-checks access via the `enforcePatientAccess` middleware using the
 * caller's session identity, NOT the localStorage value. A tampered
 * localStorage key can at worst cause a FORBIDDEN from the server.
 *
 * When the stored id is no longer in the caregiver's active link set (for
 * example after a patient revokes access), the hook silently falls back to
 * the first patient returned by `patients.getMyPatients`. This keeps the UI
 * from showing a blank dashboard after a stale id is picked up from storage.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { trpc } from "./trpc";
import { useAuth } from "./auth";

export const ACTIVE_PATIENT_STORAGE_KEY = "carebridge:active-patient-id";

export interface ViewablePatient {
  id: string;
  name: string;
  mrn: string | null;
  /** "self" for the patient role; a relationship_type token for caregivers. */
  relationship: string;
}

export interface ActivePatientContextValue {
  /** All patient records the signed-in user can view. */
  patients: ViewablePatient[];
  /** The one currently selected in the header / URL. */
  activePatient: ViewablePatient | null;
  /** Switches the active patient. Persists to localStorage. No-op for ids not in `patients`. */
  setActivePatientId: (id: string) => void;
  /** True on initial load before `getMyPatients` resolves. */
  isLoading: boolean;
  /** True when a caregiver has no active links — the portal should show an explanatory empty state. */
  hasNoPatients: boolean;
  /** True when the caregiver represents more than one patient (show the selector). */
  isMultiPatient: boolean;
  /** True when the active patient is NOT the logged-in user (banner should render). */
  isViewingAsCaregiver: boolean;
}

const ActivePatientContext = createContext<ActivePatientContextValue | null>(
  null,
);

/**
 * Resolve the active-patient id from a stored value and the candidate list.
 *
 * Exported for unit testing. Pure — no DOM / storage side effects.
 *
 * Returns null only when `patients` is empty.
 */
export function resolveActivePatientId(
  stored: string | null,
  patients: ReadonlyArray<Pick<ViewablePatient, "id">>,
): string | null {
  if (patients.length === 0) return null;
  if (stored) {
    const match = patients.find((p) => p.id === stored);
    if (match) return match.id;
  }
  return patients[0]!.id;
}

export function ActivePatientProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth();

  const { data: patients = [], isLoading } =
    trpc.patients.getMyPatients.useQuery(undefined, {
      enabled: isAuthenticated,
    });

  const [storedId, setStoredId] = useState<string | null>(null);

  // One-time hydrate from localStorage after mount (SSR-safe).
  useEffect(() => {
    try {
      const value = window.localStorage.getItem(ACTIVE_PATIENT_STORAGE_KEY);
      setStoredId(value);
    } catch {
      // localStorage may be blocked (private mode, sandboxed iframes); fall
      // through to the "first patient wins" default.
    }
  }, []);

  const activePatientId = useMemo(
    () => resolveActivePatientId(storedId, patients),
    [storedId, patients],
  );

  const activePatient = useMemo(
    () => patients.find((p) => p.id === activePatientId) ?? null,
    [patients, activePatientId],
  );

  const setActivePatientId = useCallback(
    (id: string) => {
      const match = patients.find((p) => p.id === id);
      if (!match) return;
      setStoredId(id);
      try {
        window.localStorage.setItem(ACTIVE_PATIENT_STORAGE_KEY, id);
      } catch {
        // Ignore — in-memory state still reflects the selection.
      }
    },
    [patients],
  );

  const value = useMemo<ActivePatientContextValue>(() => {
    const isViewingAsCaregiver = !!(
      activePatient &&
      user?.role === "family_caregiver" &&
      activePatient.relationship !== "self"
    );
    return {
      patients,
      activePatient,
      setActivePatientId,
      isLoading,
      hasNoPatients:
        !isLoading && patients.length === 0 && user?.role === "family_caregiver",
      isMultiPatient: patients.length > 1,
      isViewingAsCaregiver,
    };
  }, [patients, activePatient, setActivePatientId, isLoading, user?.role]);

  return (
    <ActivePatientContext.Provider value={value}>
      {children}
    </ActivePatientContext.Provider>
  );
}

export function useActivePatient(): ActivePatientContextValue {
  const ctx = useContext(ActivePatientContext);
  if (!ctx) {
    throw new Error(
      "useActivePatient must be used within an ActivePatientProvider",
    );
  }
  return ctx;
}
