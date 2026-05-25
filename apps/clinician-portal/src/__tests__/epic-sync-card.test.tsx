/**
 * @vitest-environment jsdom
 *
 * Issue #1182 — per-patient Epic sync card.
 *
 * Covers:
 *   - Admin sees the "Sync from Epic now" button; non-admin does not.
 *   - Clicking the button calls epicSync.triggerSync with incremental
 *     mode and the patient id, then invalidates getSyncStatus.
 *   - Status widget renders last-synced + error totals from the query.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const triggerMutate = vi.fn();
const invalidate = vi.fn().mockResolvedValue(undefined);

let mockedUser: { role: string } | null = { role: "admin" };

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: mockedUser }),
}));

const statusRows = [
  {
    patient_id: "p-1",
    resource_type: "Observation",
    last_synced_at: "2026-04-01T12:00:00.000Z",
    last_fhir_lastupdated: "2026-04-01T12:00:00.000Z",
    status: "ok",
    resources_synced_count: 42,
    error_count: 0,
    last_error_message: null,
    last_error_at: null,
    skipped_sub_resources: [],
  },
  {
    patient_id: "p-1",
    resource_type: "MedicationRequest",
    last_synced_at: "2026-04-01T11:30:00.000Z",
    last_fhir_lastupdated: "2026-04-01T11:30:00.000Z",
    status: "failed",
    resources_synced_count: 3,
    error_count: 2,
    last_error_message: "Epic 502",
    last_error_at: "2026-04-01T11:30:00.000Z",
    skipped_sub_resources: [],
  },
];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      epicSync: {
        getSyncStatus: { invalidate },
      },
    }),
    epicSync: {
      getSyncStatus: {
        useQuery: () => ({
          data: statusRows,
          isLoading: false,
          isError: false,
        }),
      },
      triggerSync: {
        useMutation: ({ onSuccess, onError }: {
          onSuccess?: () => void;
          onError?: (err: unknown) => void;
        } = {}) => ({
          mutate: (input: unknown) => {
            triggerMutate(input);
            onSuccess?.();
            void onError;
          },
          isPending: false,
        }),
      },
    },
  },
}));

import { EpicSyncCard } from "../components/epic-sync-card";

beforeEach(() => {
  triggerMutate.mockClear();
  invalidate.mockClear();
  mockedUser = { role: "admin" };
});

afterEach(() => {
  cleanup();
});

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("EpicSyncCard (admin)", () => {
  it("renders the Sync Now button for admins", () => {
    mockedUser = { role: "admin" };
    render(<EpicSyncCard patientId={PATIENT_ID} />);
    expect(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    ).toBeInTheDocument();
  });

  it("calls triggerSync with incremental mode and invalidates status on success", async () => {
    mockedUser = { role: "admin" };
    render(<EpicSyncCard patientId={PATIENT_ID} epicPatientFhirId="eP1" />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    await waitFor(() => expect(triggerMutate).toHaveBeenCalledTimes(1));
    expect(triggerMutate).toHaveBeenCalledWith({
      mode: "incremental",
      patient_id: PATIENT_ID,
      epic_patient_fhir_id: "eP1",
    });
    expect(invalidate).toHaveBeenCalledWith({ patient_id: PATIENT_ID });
  });

  it("displays the most-recent last-synced timestamp and aggregated error count", () => {
    render(<EpicSyncCard patientId={PATIENT_ID} />);
    // Last synced row is 2026-04-01T12:00:00 (the later one)
    expect(screen.getByText(/Last synced/i)).toBeInTheDocument();
    // Total errors = 2 (from MedicationRequest)
    const errorRow = screen.getByText(/^Errors$/);
    expect(errorRow).toBeInTheDocument();
    expect(screen.getByLabelText(/2 sync errors/i)).toBeInTheDocument();
  });
});

describe("EpicSyncCard (non-admin)", () => {
  it("hides the Sync Now button for non-admin users", () => {
    mockedUser = { role: "physician" };
    render(<EpicSyncCard patientId={PATIENT_ID} />);
    expect(
      screen.queryByRole("button", { name: /Sync from Epic now/i }),
    ).toBeNull();
  });

  it("hides the Sync Now button when there is no user", () => {
    mockedUser = null;
    render(<EpicSyncCard patientId={PATIENT_ID} />);
    expect(
      screen.queryByRole("button", { name: /Sync from Epic now/i }),
    ).toBeNull();
  });
});
