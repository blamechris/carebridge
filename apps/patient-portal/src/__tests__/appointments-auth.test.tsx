import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AppointmentsPage from "../../app/appointments/page";

const { state, replace, usePatientRecord } = vi.hoisted(() => ({
  state: { hydrated: true, verifying: true, isAuthenticated: false },
  replace: vi.fn(),
  usePatientRecord: vi.fn(() => ({ isLoading: true })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@carebridge/portal-shared/auth", () => ({
  useAuth: () => state,
}));

vi.mock("@/lib/use-my-patient", () => ({
  useMyPatientRecord: usePatientRecord,
}));

vi.mock("@/lib/trpc", () => {
  const query = { useQuery: () => ({}) };
  const mutation = { useMutation: () => ({}) };
  return {
    trpc: {
      useUtils: () => ({}),
      scheduling: {
        appointments: {
          listByPatient: query,
          create: mutation,
          cancel: mutation,
          reschedule: mutation,
        },
      },
      patients: { careTeam: { getByPatient: query } },
    },
  };
});

it("waits for session verification before mounting the appointments data hooks", () => {
  const { rerender } = render(<AppointmentsPage />);

  expect(screen.getByText("Loading...")).toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
  expect(usePatientRecord).not.toHaveBeenCalled();

  state.verifying = false;
  state.isAuthenticated = true;
  rerender(<AppointmentsPage />);

  expect(screen.getByText("Loading your record...")).toBeInTheDocument();
  expect(usePatientRecord).toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});
