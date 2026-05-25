/**
 * @vitest-environment jsdom
 *
 * Issue #1182 — Connect to Epic settings panel.
 *
 * Covers:
 *   - "Connect to Epic" form validates URL, then navigates to the
 *     gateway's /auth/epic/authorize URL with iss + redirect set.
 *   - Connection list renders each linked Epic org.
 *   - Disconnect button calls epicAuth.disconnect with the right iss.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const disconnectMutate = vi.fn();
const invalidate = vi.fn().mockResolvedValue(undefined);

vi.mock("@carebridge/portal-shared/trpc", () => ({
  getApiBaseUrl: () => "http://api.test",
}));

const connections = [
  {
    id: "conn-1",
    epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
    scopes: "openid fhirUser launch/patient patient/*.read",
    expires_at: "2099-01-01T00:00:00.000Z",
    epic_practitioner_fhir_id: "prac-123",
    epic_patient_fhir_id: null,
    launch_encounter_fhir_id: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  },
  {
    id: "conn-2",
    epic_org_iss: "https://fhir.epic.test/api/FHIR/R4",
    scopes: "openid fhirUser patient/*.read",
    expires_at: "2099-01-01T00:00:00.000Z",
    epic_practitioner_fhir_id: null,
    epic_patient_fhir_id: null,
    launch_encounter_fhir_id: null,
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
  },
];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      epicAuth: {
        getMyConnections: { invalidate },
      },
    }),
    epicAuth: {
      getMyConnections: {
        useQuery: () => ({
          data: connections,
          isLoading: false,
          isError: false,
        }),
      },
      disconnect: {
        useMutation: ({ onSuccess, onError }: {
          onSuccess?: () => void;
          onError?: (err: unknown) => void;
        } = {}) => ({
          mutate: (input: { epic_org_iss: string }) => {
            disconnectMutate(input);
            onSuccess?.();
            void onError;
          },
          isPending: false,
        }),
      },
    },
  },
}));

import { EpicIntegrationsPanel } from "../components/epic-integrations-panel";

afterEach(() => {
  cleanup();
  disconnectMutate.mockClear();
  invalidate.mockClear();
});

describe("EpicIntegrationsPanel (Connect)", () => {
  it("renders the connect form and connection list", () => {
    render(<EpicIntegrationsPanel />);
    expect(screen.getByLabelText(/Epic FHIR base URL/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Connect to Epic/i }),
    ).toBeInTheDocument();
    // Both connections render.
    expect(
      screen.getByText("https://fhir.epic.example/api/FHIR/R4"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://fhir.epic.test/api/FHIR/R4"),
    ).toBeInTheDocument();
  });

  it("shows a validation error when iss is empty", () => {
    const navigate = vi.fn();
    render(<EpicIntegrationsPanel navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: /Connect to Epic/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/enter your epic/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects a non-https URL (other than localhost)", () => {
    const navigate = vi.fn();
    render(<EpicIntegrationsPanel navigate={navigate} />);

    fireEvent.change(screen.getByLabelText(/Epic FHIR base URL/i), {
      target: { value: "http://insecure.epic.example/api/FHIR/R4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect to Epic/i }));

    expect(screen.getByRole("alert").textContent).toMatch(/https/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates to the authorize URL with iss + redirect on valid submit", () => {
    const navigate = vi.fn();
    render(
      <EpicIntegrationsPanel
        apiBaseUrl="http://api.test"
        navigate={navigate}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Epic FHIR base URL/i), {
      target: { value: "https://fhir.epic.example/api/FHIR/R4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect to Epic/i }));

    expect(navigate).toHaveBeenCalledTimes(1);
    const target = navigate.mock.calls[0][0] as string;
    expect(target).toContain("http://api.test/auth/epic/authorize");
    expect(target).toContain(
      `iss=${encodeURIComponent("https://fhir.epic.example/api/FHIR/R4")}`,
    );
    expect(target).toContain(
      `redirect=${encodeURIComponent("/settings/integrations")}`,
    );
  });
});

describe("EpicIntegrationsPanel (Disconnect)", () => {
  it("calls disconnect with the correct iss when clicked", async () => {
    render(<EpicIntegrationsPanel />);

    const disconnectButtons = screen.getAllByRole("button", {
      name: /Disconnect /i,
    });
    expect(disconnectButtons).toHaveLength(2);

    fireEvent.click(disconnectButtons[0]);
    await waitFor(() => expect(disconnectMutate).toHaveBeenCalledTimes(1));
    expect(disconnectMutate).toHaveBeenCalledWith({
      epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
    });
  });
});
