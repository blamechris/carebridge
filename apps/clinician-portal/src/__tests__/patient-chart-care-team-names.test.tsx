/**
 * @vitest-environment jsdom
 *
 * Issue #1304 — the patient chart's Care Team panel was rendering raw
 * `provider_id` UUIDs instead of the provider's name + specialty.
 *
 * The gateway's `patients.careTeam.getByPatient` now LEFT JOINs `users`
 * and surfaces `provider_name` + `provider_specialty`. The Overview tab
 * must render those fields, and must fall back to "Unknown provider"
 * when the join returns null (stale roster entry / deleted user).
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
import { render, cleanup, screen, within } from "@testing-library/react";

let mockCareTeam: Array<{
  id: string;
  patient_id: string;
  provider_id: string;
  role: string;
  specialty: string | null;
  is_active: boolean;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  provider_name: string | null;
  provider_specialty: string | null;
}> = [];

const { patient } = vi.hoisted(() => ({
  patient: {
    id: "patient-1",
    name: "Margaret Chen",
    mrn: "MRN-0001",
    date_of_birth: "1970-01-01",
    biological_sex: "F",
    allergy_status: "nkda",
  },
}));

vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "physician", name: "T" } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "patient-1" }),
  useSearchParams: () => ({
    get: () => null,
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/vitals-trend-chart", () => ({
  VitalsTrendChart: () => null,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/epic-sync-card", () => ({
  EpicSyncCard: () => null,
}));

vi.mock("@/lib/trpc", () => {
  const stubQuery = <T,>(data: T) => ({
    useQuery: () => ({ data, isLoading: false, isError: false }),
  });

  const proxyFor = (path: string): unknown => {
    if (path === "patients.getById") return stubQuery(patient);
    if (path === "patients.diagnoses.getByPatient") return stubQuery([]);
    if (path === "patients.allergies.getByPatient") return stubQuery([]);
    if (path === "patients.careTeam.getByPatient") return stubQuery(mockCareTeam);
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
            return () => ({});
          }
          if (prop === "useQuery" || prop === "useMutation") {
            const target = proxyFor(path.join(".")) as Record<string, unknown>;
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
  mockCareTeam = [];
});

afterEach(() => {
  cleanup();
});

function makeMember(overrides: Partial<(typeof mockCareTeam)[number]>) {
  return {
    id: "ctm-1",
    patient_id: "patient-1",
    provider_id: "4fbb067d-bfca-4e24-84cf-0e04cf88b4db",
    role: "primary",
    specialty: null,
    is_active: true,
    started_at: "2025-01-01T00:00:00Z",
    ended_at: null,
    created_at: "2025-01-01T00:00:00Z",
    provider_name: null,
    provider_specialty: null,
    ...overrides,
  };
}

describe("patient chart care-team renders provider names + specialty (#1304)", () => {
  it("renders name and specialty for each care-team row", () => {
    mockCareTeam = [
      makeMember({
        id: "ctm-1",
        role: "primary",
        provider_name: "Dr. Sarah Smith",
        provider_specialty: "Hematology/Oncology",
      }),
      makeMember({
        id: "ctm-2",
        role: "specialist",
        provider_id: "4521c6bf-e6bd-45e8-80c4-1319f67fc7a2",
        provider_name: "Dr. Michael Jones",
        provider_specialty: "Interventional Radiology",
      }),
      makeMember({
        id: "ctm-3",
        role: "nurse",
        provider_id: "b2fa0be2-c448-49ec-8588-7fdfd5679260",
        provider_name: "Rachel Torres, RN",
        provider_specialty: "Oncology",
      }),
    ];

    render(<PatientChartPage />);

    // Heading still present.
    expect(screen.getByText("Care Team")).toBeTruthy();

    // Names + specialties rendered for all three rows.
    expect(
      screen.getByText("Dr. Sarah Smith — Hematology/Oncology"),
    ).toBeTruthy();
    expect(
      screen.getByText("Dr. Michael Jones — Interventional Radiology"),
    ).toBeTruthy();
    expect(screen.getByText("Rachel Torres, RN — Oncology")).toBeTruthy();

    // Raw UUIDs MUST NOT leak into the rendered chart.
    expect(
      screen.queryByText("4fbb067d-bfca-4e24-84cf-0e04cf88b4db"),
    ).toBeNull();
    expect(
      screen.queryByText("4521c6bf-e6bd-45e8-80c4-1319f67fc7a2"),
    ).toBeNull();
    expect(
      screen.queryByText("b2fa0be2-c448-49ec-8588-7fdfd5679260"),
    ).toBeNull();
  });

  it("falls back to 'Unknown provider' when the joined user row is missing", () => {
    mockCareTeam = [
      makeMember({
        role: "specialist",
        provider_name: null,
        provider_specialty: null,
      }),
    ];

    render(<PatientChartPage />);

    expect(screen.getByText("Unknown provider")).toBeTruthy();
    // Even the fallback row must not leak the UUID.
    expect(
      screen.queryByText("4fbb067d-bfca-4e24-84cf-0e04cf88b4db"),
    ).toBeNull();
  });

  it("renders name only when specialty is null but the user record exists", () => {
    mockCareTeam = [
      makeMember({
        role: "nurse",
        provider_name: "Casey Coordinator",
        provider_specialty: null,
      }),
    ];

    render(<PatientChartPage />);

    // No "— specialty" suffix when specialty is null.
    const careCard = screen.getByText("Care Team").parentElement!;
    expect(within(careCard).getByText("Casey Coordinator")).toBeTruthy();
    expect(within(careCard).queryByText(/—/)).toBeNull();
  });
});
