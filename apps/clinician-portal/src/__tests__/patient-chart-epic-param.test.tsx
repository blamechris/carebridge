/**
 * @vitest-environment jsdom
 *
 * Issue #1188 — forward the `?epic_patient` URL param from the Epic SMART
 * launch flow into `<EpicSyncCard>` so the "Sync from Epic now" action
 * skips the stored-mapping round-trip.
 *
 * Three behaviours are exercised:
 *   1. URL param present and well-formed → forwarded as
 *      `epicPatientFhirId` prop and ends up in the `triggerSync` payload
 *      as `epic_patient_fhir_id`.
 *   2. URL param absent → not forwarded; the mutation is called without
 *      `epic_patient_fhir_id` (effectively `undefined`).
 *   3. URL param malformed (e.g. `<script>` injection, oversize) → not
 *      forwarded. The card behaves identically to the no-param case so
 *      a hostile URL cannot poison the downstream tRPC call.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------
// Mutable mocks
// ---------------------------------------------------------------------

let mockEpicPatientParam: string | null = null;
let mockTabParam: string | null = null;

const triggerMutate = vi.fn();
const invalidate = vi.fn().mockResolvedValue(undefined);

const { patient } = vi.hoisted(() => ({
  patient: {
    id: "patient-1",
    name: "Jane Doe",
    mrn: "MRN-0001",
    date_of_birth: "1970-01-01",
    biological_sex: "F",
    allergy_status: "nkda",
  },
}));

// AuthGuard pass-through.
vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Admin so the Sync Now button is rendered and we can click it.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin", name: "T" } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "patient-1" }),
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === "tab") return mockTabParam;
      if (key === "epic_patient") return mockEpicPatientParam;
      return null;
    },
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/vitals-trend-chart", () => ({
  VitalsTrendChart: () => null,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

// Permissive tRPC mock; we override the handful of procs the Overview
// tab + EpicSyncCard actually exercise. triggerSync is wired to a real
// vi.fn so we can assert on its payload.
vi.mock("@/lib/trpc", () => {
  const stubQuery = <T,>(data: T) => ({
    useQuery: () => ({ data, isLoading: false, isError: false }),
  });

  const proxyFor = (path: string): unknown => {
    if (path === "patients.getById") {
      return stubQuery(patient);
    }
    if (path === "patients.diagnoses.getByPatient") return stubQuery([]);
    if (path === "patients.allergies.getByPatient") return stubQuery([]);
    if (path === "patients.careTeam.getByPatient") return stubQuery([]);
    if (path === "epicSync.getSyncStatus") return stubQuery([]);

    // Default: loading-but-quiet.
    return {
      useQuery: () => ({ data: undefined, isLoading: true, isError: false }),
      useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    };
  };

  const proxy = (path: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return undefined;
          if (prop === "useUtils") {
            return () => ({
              epicSync: {
                getSyncStatus: { invalidate },
              },
              // Deep proxy for any other utils chain.
              get: () => ({}),
            });
          }
          if (prop === "useQuery" || prop === "useMutation") {
            const target = proxyFor(path.join(".")) as Record<string, unknown>;
            if (prop === "useMutation" && path.join(".") === "epicSync.triggerSync") {
              return ({ onSuccess }: { onSuccess?: () => void } = {}) => ({
                mutate: (input: unknown) => {
                  triggerMutate(input);
                  onSuccess?.();
                },
                isPending: false,
              });
            }
            const fn = target[prop];
            if (typeof fn === "function") return fn;
            if (prop === "useMutation") {
              return () => ({ mutate: vi.fn(), isPending: false });
            }
            return () => ({ data: undefined, isLoading: true, isError: false });
          }
          return proxy([...path, prop]);
        },
      },
    );

  return { trpc: proxy([]) };
});

import PatientChartPage from "../../app/patients/[id]/page";

beforeEach(() => {
  triggerMutate.mockClear();
  invalidate.mockClear();
  mockEpicPatientParam = null;
  mockTabParam = null;
});

afterEach(() => {
  cleanup();
});

describe("patient chart forwards ?epic_patient to EpicSyncCard (#1188)", () => {
  it("forwards a well-formed epic_patient param into triggerSync", () => {
    mockEpicPatientParam = "eP1";

    render(<PatientChartPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    expect(triggerMutate).toHaveBeenCalledTimes(1);
    expect(triggerMutate).toHaveBeenCalledWith({
      mode: "incremental",
      patient_id: "patient-1",
      epic_patient_fhir_id: "eP1",
    });
  });

  it("does not forward epic_patient_fhir_id when the param is absent", () => {
    mockEpicPatientParam = null;

    render(<PatientChartPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    expect(triggerMutate).toHaveBeenCalledTimes(1);
    const payload = triggerMutate.mock.calls[0]?.[0] as {
      epic_patient_fhir_id?: string;
    };
    expect(payload.epic_patient_fhir_id).toBeUndefined();
  });

  it("rejects a malformed epic_patient param (script injection)", () => {
    mockEpicPatientParam = "<script>alert(1)</script>";

    render(<PatientChartPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    expect(triggerMutate).toHaveBeenCalledTimes(1);
    const payload = triggerMutate.mock.calls[0]?.[0] as {
      epic_patient_fhir_id?: string;
    };
    expect(payload.epic_patient_fhir_id).toBeUndefined();
  });

  it("rejects an over-length epic_patient param (>64 chars per FHIR spec)", () => {
    // 65 a's — one more than the FHIR id max length.
    mockEpicPatientParam = "a".repeat(65);

    render(<PatientChartPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    expect(triggerMutate).toHaveBeenCalledTimes(1);
    const payload = triggerMutate.mock.calls[0]?.[0] as {
      epic_patient_fhir_id?: string;
    };
    expect(payload.epic_patient_fhir_id).toBeUndefined();
  });

  it("accepts a FHIR id at the 64-char boundary with allowed separators", () => {
    // Mix of alphanumerics, hyphens and dots — full FHIR id grammar,
    // exactly 64 chars.
    const id = "ePatient-001.with.dots-and-dashes-".padEnd(64, "X");
    expect(id).toHaveLength(64);
    mockEpicPatientParam = id;

    render(<PatientChartPage />);

    fireEvent.click(
      screen.getByRole("button", { name: /Sync from Epic now/i }),
    );

    expect(triggerMutate).toHaveBeenCalledTimes(1);
    expect(triggerMutate).toHaveBeenCalledWith({
      mode: "incremental",
      patient_id: "patient-1",
      epic_patient_fhir_id: id,
    });
  });
});
