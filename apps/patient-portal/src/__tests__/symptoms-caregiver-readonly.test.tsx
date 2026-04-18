import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Auth — signed-in caregiver (role controls write-path toggling).
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "caregiver-1",
      email: "c@carebridge.dev",
      name: "C",
      role: "family_caregiver",
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    isAuthenticated: true,
    sessionId: "s-1",
    setSession: vi.fn(),
    clearSession: vi.fn(),
    hydrated: true,
    verifying: false,
  }),
}));

vi.mock("@/lib/use-my-patient", () => ({
  useMyPatientRecord: () => ({
    patient: {
      id: "linked-1",
      name: "Jane Doe",
      mrn: "MRN001",
      date_of_birth: "1960-01-01",
      biological_sex: "female",
    },
    isLoading: false,
    isError: false,
    isUnlinked: false,
  }),
}));

// Controllable active-patient mock — flipped per test.
const activePatientState = {
  isViewingAsCaregiver: true,
};

vi.mock("@/lib/active-patient", () => ({
  useActivePatient: () => ({
    patients: [],
    activePatient: {
      id: "linked-1",
      name: "Jane Doe",
      mrn: "MRN001",
      relationship: "spouse",
    },
    setActivePatientId: vi.fn(),
    isLoading: false,
    hasNoPatients: false,
    isMultiPatient: false,
    isViewingAsCaregiver: activePatientState.isViewingAsCaregiver,
  }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      patients: {
        observations: {
          getByPatient: { invalidate: vi.fn() },
        },
      },
    }),
    patients: {
      observations: {
        getByPatient: {
          useQuery: () => ({ data: [], isLoading: false, isError: false }),
        },
        create: {
          useMutation: () => ({
            mutate: vi.fn(),
            isPending: false,
            isError: false,
          }),
        },
      },
    },
  },
}));

import SymptomsPage from "../../app/symptoms/page";

describe("SymptomsPage — caregiver read-only state", () => {
  beforeEach(() => {
    activePatientState.isViewingAsCaregiver = true;
  });

  afterEach(() => cleanup());

  it("shows the read-only notice when viewing as caregiver", () => {
    render(<SymptomsPage />);
    expect(
      screen.getByTestId("symptoms-caregiver-readonly-notice"),
    ).toBeInTheDocument();
  });

  it("disables the submit button when viewing as caregiver", () => {
    render(<SymptomsPage />);
    const button = screen.getByTestId("symptoms-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button).toHaveAttribute(
      "title",
      expect.stringMatching(/caregivers cannot submit/i),
    );
  });

  it("does NOT show the read-only notice when the user is the patient", () => {
    activePatientState.isViewingAsCaregiver = false;
    render(<SymptomsPage />);
    expect(
      screen.queryByTestId("symptoms-caregiver-readonly-notice"),
    ).toBeNull();
  });
});
