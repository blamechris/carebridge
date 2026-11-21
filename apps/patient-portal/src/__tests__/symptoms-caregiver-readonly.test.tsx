import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const replace = vi.fn();
const usePatientRecord = vi.fn();
const authState = { isAuthenticated: true, hydrated: true, verifying: false };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}));

vi.mock("@carebridge/portal-shared/auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/lib/use-my-patient", () => ({
  useMyPatientRecord: () => {
    usePatientRecord();
    return {
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
    };
  },
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
    authState.isAuthenticated = true;
    authState.hydrated = true;
    authState.verifying = false;
    replace.mockClear();
    usePatientRecord.mockClear();
  });

  afterEach(() => cleanup());

  it.each([
    ["caregiver", true],
    ["patient", false],
  ])("waits for the %s session on direct navigation", (_role, isViewingAsCaregiver) => {
    activePatientState.isViewingAsCaregiver = isViewingAsCaregiver;
    authState.isAuthenticated = false;
    authState.hydrated = false;
    const { rerender } = render(<SymptomsPage />);

    expect(screen.queryByText("How Are You Feeling?")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(usePatientRecord).not.toHaveBeenCalled();

    authState.hydrated = true;
    authState.verifying = true;
    rerender(<SymptomsPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(usePatientRecord).not.toHaveBeenCalled();

    authState.verifying = false;
    authState.isAuthenticated = true;
    rerender(<SymptomsPage />);
    expect(screen.getByText("How Are You Feeling?")).toBeDefined();
    expect(!!screen.queryByTestId("symptoms-caregiver-readonly-notice")).toBe(isViewingAsCaregiver);
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects after restoration completes without a session", () => {
    authState.isAuthenticated = false;
    render(<SymptomsPage />);
    expect(replace).toHaveBeenCalledWith("/login");
    expect(usePatientRecord).not.toHaveBeenCalled();
  });


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
