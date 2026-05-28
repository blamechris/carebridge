/**
 * @vitest-environment jsdom
 *
 * Issue #1274 — when `/notes/new?patientId=<uuid>` lands with a patient
 * id that is not in the loaded `patients.list` (deleted, no access, or
 * malformed), the page should:
 *   1. clear the prefilled `patientId` state so the user can't submit
 *      a value the server will 403 on, and
 *   2. surface a small inline notice next to the Patient dropdown so
 *      the user knows why the field reset.
 *
 * The happy path — a prefill that *does* match a loaded patient — must
 * be untouched.
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
import { render, cleanup, screen } from "@testing-library/react";

// ---------------------------------------------------------------------
// Mutable mocks
// ---------------------------------------------------------------------

let mockPatientIdParam: string | null = null;
let mockPatients: { id: string; name: string; mrn?: string }[] = [];

vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "physician", name: "T" } }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "patientId" ? mockPatientIdParam : null),
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Minimal tRPC mock: patients.list returns the configured `mockPatients`
// array; notes.templates.get returns a stable empty template; notes.create
// is a no-op mutation. Stable object references are crucial — React's
// effect deps will fire on every render if `data` is a fresh ref each
// time, which would loop forever once setSections / setPatientId run.
const stableEmptyTemplate: never[] = [];
const stableCreateMutation = {
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null,
};
vi.mock("@/lib/trpc", () => {
  const trpc = {
    patients: {
      list: {
        useQuery: () => ({
          data: mockPatients,
          isLoading: false,
          isError: false,
        }),
      },
    },
    notes: {
      templates: {
        get: {
          useQuery: () => ({
            data: stableEmptyTemplate,
            isLoading: false,
            isError: false,
          }),
        },
      },
      create: {
        useMutation: () => stableCreateMutation,
      },
    },
  };
  return { trpc };
});

import NewNotePage from "../../app/notes/new/page";

beforeEach(() => {
  mockPatientIdParam = null;
  mockPatients = [];
});

afterEach(() => {
  cleanup();
});

describe("/notes/new reconciles prefilled patientId (#1274)", () => {
  it("clears the prefill and shows an inline notice when the id is not in the loaded list", async () => {
    mockPatientIdParam = "ghost-patient-uuid";
    mockPatients = [
      { id: "patient-1", name: "Jane Doe", mrn: "MRN-0001" },
      { id: "patient-2", name: "John Roe", mrn: "MRN-0002" },
    ];

    render(<NewNotePage />);

    // The Patient dropdown is the first `combobox` on the page (the
    // Template dropdown is the second). The label isn't htmlFor-tied
    // so we select by role + position.
    const select = (await screen.findAllByRole("combobox"))[0] as HTMLSelectElement;
    expect(select).toBeDefined();
    // After the reconcile effect runs, the select should fall back to
    // the empty "Select a patient..." option, not the ghost UUID.
    expect(select.value).toBe("");

    // Inline notice should be present.
    expect(
      screen.getByText(/Patient not available — please pick another\./i),
    ).toBeDefined();
  });

  it("keeps the prefill and shows no notice when the id is in the loaded list", async () => {
    mockPatientIdParam = "patient-2";
    mockPatients = [
      { id: "patient-1", name: "Jane Doe", mrn: "MRN-0001" },
      { id: "patient-2", name: "John Roe", mrn: "MRN-0002" },
    ];

    render(<NewNotePage />);

    // The Patient dropdown is the first `combobox` on the page (the
    // Template dropdown is the second). The label isn't htmlFor-tied
    // so we select by role + position.
    const select = (await screen.findAllByRole("combobox"))[0] as HTMLSelectElement;
    expect(select.value).toBe("patient-2");
    expect(
      screen.queryByText(/Patient not available — please pick another\./i),
    ).toBeNull();
  });

  it("does nothing when no patientId is prefilled at all", async () => {
    mockPatientIdParam = null;
    mockPatients = [{ id: "patient-1", name: "Jane Doe", mrn: "MRN-0001" }];

    render(<NewNotePage />);

    // The Patient dropdown is the first `combobox` on the page (the
    // Template dropdown is the second). The label isn't htmlFor-tied
    // so we select by role + position.
    const select = (await screen.findAllByRole("combobox"))[0] as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(
      screen.queryByText(/Patient not available — please pick another\./i),
    ).toBeNull();
  });
});
