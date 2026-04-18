import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Controllable `useActivePatient` mock. Each test swaps the return value.
const activePatientState: {
  value: {
    patients: Array<{
      id: string;
      name: string;
      mrn: string | null;
      relationship: string;
    }>;
    activePatient: {
      id: string;
      name: string;
      mrn: string | null;
      relationship: string;
    } | null;
    setActivePatientId: (id: string) => void;
    isLoading: boolean;
    hasNoPatients: boolean;
    isMultiPatient: boolean;
    isViewingAsCaregiver: boolean;
  };
} = {
  value: {
    patients: [],
    activePatient: null,
    setActivePatientId: vi.fn(),
    isLoading: false,
    hasNoPatients: false,
    isMultiPatient: false,
    isViewingAsCaregiver: false,
  },
};

vi.mock("@/lib/active-patient", () => ({
  useActivePatient: () => activePatientState.value,
}));

import {
  CaregiverIndicator,
  humanizeRelationship,
} from "@/components/caregiver-indicator";

describe("CaregiverIndicator", () => {
  afterEach(() => {
    cleanup();
    activePatientState.value = {
      patients: [],
      activePatient: null,
      setActivePatientId: vi.fn(),
      isLoading: false,
      hasNoPatients: false,
      isMultiPatient: false,
      isViewingAsCaregiver: false,
    };
  });

  it("renders nothing when the user is not viewing as a caregiver", () => {
    const { container } = render(<CaregiverIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when isViewingAsCaregiver is true but activePatient is null", () => {
    activePatientState.value = {
      ...activePatientState.value,
      isViewingAsCaregiver: true,
      activePatient: null,
    };
    const { container } = render(<CaregiverIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner with the patient name when viewing as caregiver", () => {
    activePatientState.value = {
      ...activePatientState.value,
      isViewingAsCaregiver: true,
      activePatient: {
        id: "p1",
        name: "Jane Doe",
        mrn: "MRN001",
        relationship: "spouse",
      },
    };
    render(<CaregiverIndicator />);
    const banner = screen.getByTestId("caregiver-indicator");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Viewing as spouse for Jane Doe/i);
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("humanizes healthcare_poa to 'healthcare proxy'", () => {
    expect(humanizeRelationship("healthcare_poa")).toBe("healthcare proxy");
  });

  it("falls back to 'caregiver' for unknown relationship types", () => {
    expect(humanizeRelationship("bff")).toBe("caregiver");
  });
});
