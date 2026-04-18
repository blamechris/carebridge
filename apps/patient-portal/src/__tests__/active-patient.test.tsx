import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";

import {
  ACTIVE_PATIENT_STORAGE_KEY,
  resolveActivePatientId,
} from "@/lib/active-patient";

// ---------- Pure resolver ---------------------------------------------------

describe("resolveActivePatientId", () => {
  const P1 = { id: "p1" };
  const P2 = { id: "p2" };

  it("returns null when the list is empty", () => {
    expect(resolveActivePatientId(null, [])).toBeNull();
    expect(resolveActivePatientId("anything", [])).toBeNull();
  });

  it("returns the stored id when it matches a candidate", () => {
    expect(resolveActivePatientId("p2", [P1, P2])).toBe("p2");
  });

  it("falls back to the first candidate when the stored id is absent", () => {
    expect(resolveActivePatientId(null, [P1, P2])).toBe("p1");
  });

  it("falls back to the first candidate when the stored id is stale", () => {
    // The caregiver's access was revoked for the previously-active patient.
    expect(resolveActivePatientId("p-revoked", [P1, P2])).toBe("p1");
  });
});

// ---------- React context hook ---------------------------------------------

// Mocks must be set up before the component module is imported because the
// hook captures `trpc.patients.getMyPatients.useQuery` at module load.

const trpcState = {
  getMyPatientsData: [] as Array<{
    id: string;
    name: string;
    mrn: string | null;
    relationship: string;
  }>,
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    patients: {
      getMyPatients: {
        useQuery: () => ({
          data: trpcState.getMyPatientsData,
          isLoading: false,
        }),
      },
      getById: {
        useQuery: () => ({ data: null, isLoading: false, isError: false }),
      },
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "caregiver-1",
      email: "c@c.dev",
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

// Import AFTER mocks have been registered.
import {
  ActivePatientProvider,
  useActivePatient,
} from "@/lib/active-patient";

function Probe() {
  const ctx = useActivePatient();
  return (
    <div>
      <span data-testid="active-id">{ctx.activePatient?.id ?? "none"}</span>
      <span data-testid="is-caregiver">
        {String(ctx.isViewingAsCaregiver)}
      </span>
      <span data-testid="is-multi">{String(ctx.isMultiPatient)}</span>
      <button onClick={() => ctx.setActivePatientId("p2")}>switch</button>
    </div>
  );
}

describe("ActivePatientProvider + useActivePatient", () => {
  beforeEach(() => {
    window.localStorage.clear();
    trpcState.getMyPatientsData = [];
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("uses the localStorage-stored id when it is in the candidate list", async () => {
    trpcState.getMyPatientsData = [
      { id: "p1", name: "Alice", mrn: "M1", relationship: "parent" },
      { id: "p2", name: "Bob", mrn: "M2", relationship: "child" },
    ];
    window.localStorage.setItem(ACTIVE_PATIENT_STORAGE_KEY, "p2");

    render(
      <ActivePatientProvider>
        <Probe />
      </ActivePatientProvider>,
    );

    // The hydration effect runs after first paint — findByText awaits it.
    expect(await screen.findByTestId("active-id")).toHaveTextContent("p2");
  });

  it("falls back to the first patient when localStorage is empty", async () => {
    trpcState.getMyPatientsData = [
      { id: "p1", name: "Alice", mrn: "M1", relationship: "parent" },
      { id: "p2", name: "Bob", mrn: "M2", relationship: "child" },
    ];

    render(
      <ActivePatientProvider>
        <Probe />
      </ActivePatientProvider>,
    );

    expect(await screen.findByTestId("active-id")).toHaveTextContent("p1");
  });

  it("signals isViewingAsCaregiver when active relationship is not 'self'", async () => {
    trpcState.getMyPatientsData = [
      { id: "p1", name: "Alice", mrn: "M1", relationship: "spouse" },
    ];

    render(
      <ActivePatientProvider>
        <Probe />
      </ActivePatientProvider>,
    );

    expect(await screen.findByTestId("is-caregiver")).toHaveTextContent(
      "true",
    );
  });

  it("signals isMultiPatient only when more than one patient is available", async () => {
    trpcState.getMyPatientsData = [
      { id: "p1", name: "Alice", mrn: "M1", relationship: "spouse" },
      { id: "p2", name: "Bob", mrn: "M2", relationship: "child" },
    ];

    render(
      <ActivePatientProvider>
        <Probe />
      </ActivePatientProvider>,
    );

    expect(await screen.findByTestId("is-multi")).toHaveTextContent("true");
  });

  it("switches active patient and persists the choice to localStorage", async () => {
    trpcState.getMyPatientsData = [
      { id: "p1", name: "Alice", mrn: "M1", relationship: "parent" },
      { id: "p2", name: "Bob", mrn: "M2", relationship: "child" },
    ];

    render(
      <ActivePatientProvider>
        <Probe />
      </ActivePatientProvider>,
    );

    // Initially the first patient is active.
    expect(await screen.findByTestId("active-id")).toHaveTextContent("p1");

    await act(async () => {
      screen.getByRole("button", { name: /switch/i }).click();
    });

    expect(screen.getByTestId("active-id")).toHaveTextContent("p2");
    expect(
      window.localStorage.getItem(ACTIVE_PATIENT_STORAGE_KEY),
    ).toBe("p2");
  });
});
