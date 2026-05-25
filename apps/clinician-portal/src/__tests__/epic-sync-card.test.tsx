/**
 * @vitest-environment jsdom
 *
 * Issue #1182 — per-patient Epic sync card.
 * Issue #1189 — inactive-state row when the user has no Epic connection
 *   and there are no historical sync rows for the patient.
 *
 * Covers:
 *   - Admin sees the "Sync from Epic now" button; non-admin does not.
 *   - Clicking the button calls epicSync.triggerSync with incremental
 *     mode and the patient id, then invalidates getSyncStatus.
 *   - Status widget renders last-synced + error totals from the query.
 *   - Four-quadrant gating on (connections × sync-rows): only the
 *     (0 connections, 0 rows) cell collapses to the inactive-state hint.
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

interface SyncRow {
  patient_id: string;
  resource_type: string;
  last_synced_at: string | null;
  last_fhir_lastupdated: string | null;
  status: string;
  resources_synced_count: number;
  error_count: number;
  last_error_message: string | null;
  last_error_at: string | null;
  skipped_sub_resources: string[];
}

interface ConnectionRow {
  id: string;
  epic_org_iss: string;
  scopes: string;
  expires_at: string;
  epic_practitioner_fhir_id: string | null;
  epic_patient_fhir_id: string | null;
  launch_encounter_fhir_id: string | null;
  created_at: string;
  updated_at: string;
}

const populatedStatusRows: SyncRow[] = [
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

const populatedConnectionRows: ConnectionRow[] = [
  {
    id: "conn-1",
    epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
    scopes: "openid fhirUser patient/*.read",
    expires_at: "2099-01-01T00:00:00.000Z",
    epic_practitioner_fhir_id: "prac-1",
    epic_patient_fhir_id: "pat-1",
    launch_encounter_fhir_id: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  },
];

let statusRows: SyncRow[] = populatedStatusRows;
let connectionRows: ConnectionRow[] = populatedConnectionRows;

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
    epicAuth: {
      getMyConnections: {
        useQuery: () => ({
          data: connectionRows,
          isLoading: false,
          isError: false,
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
  statusRows = populatedStatusRows;
  connectionRows = populatedConnectionRows;
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

/**
 * Issue #1189 — four-quadrant inactive-state gating.
 *
 * Only the (0 connections × 0 sync-rows) cell should collapse to the
 * minimal "Sync inactive" hint. The other three cells preserve the
 * full card so users with either historical sync data OR an active
 * Epic connection retain visibility into sync state.
 */
describe("EpicSyncCard (inactive-state — issue #1189)", () => {
  it("renders the inactive-state hint when there are no connections and no sync rows", () => {
    connectionRows = [];
    statusRows = [];
    render(<EpicSyncCard patientId={PATIENT_ID} />);

    expect(screen.getByText(/Sync inactive/i)).toBeInTheDocument();
    const settingsLink = screen.getByRole("link", {
      name: /connect to Epic in Settings/i,
    });
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink.getAttribute("href")).toBe("/settings/integrations");

    // None of the full-card chrome should render.
    expect(screen.queryByText(/Last synced/i)).toBeNull();
    expect(screen.queryByText(/^Errors$/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Sync from Epic now/i }),
    ).toBeNull();
  });

  it("renders the full card when there are no connections but historical sync rows exist", () => {
    connectionRows = [];
    statusRows = populatedStatusRows;
    render(<EpicSyncCard patientId={PATIENT_ID} />);

    expect(screen.queryByText(/Sync inactive/i)).toBeNull();
    expect(screen.getByText(/Last synced/i)).toBeInTheDocument();
    expect(screen.getByText(/^Errors$/)).toBeInTheDocument();
  });

  it("renders the full card when the user has an Epic connection but no sync rows yet", () => {
    connectionRows = populatedConnectionRows;
    statusRows = [];
    render(<EpicSyncCard patientId={PATIENT_ID} />);

    expect(screen.queryByText(/Sync inactive/i)).toBeNull();
    expect(screen.getByText(/Last synced/i)).toBeInTheDocument();
    // Empty-but-connected state: no sync timestamp yet, zero errors.
    const lastSyncedRow = screen.getByText(/Last synced/i).parentElement;
    expect(lastSyncedRow?.textContent).toMatch(/never/i);
    expect(screen.getByText(/^Errors$/)).toBeInTheDocument();
  });

  it("renders the full card when the user has both connections and sync rows", () => {
    connectionRows = populatedConnectionRows;
    statusRows = populatedStatusRows;
    render(<EpicSyncCard patientId={PATIENT_ID} />);

    expect(screen.queryByText(/Sync inactive/i)).toBeNull();
    expect(screen.getByText(/Last synced/i)).toBeInTheDocument();
    expect(screen.getByText(/^Errors$/)).toBeInTheDocument();
  });
});
