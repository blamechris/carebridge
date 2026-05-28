/**
 * @vitest-environment jsdom
 *
 * Issue #1276 — guard the `?patientId=<id>` initializer added by PR #1269
 * (closes #1263). The "+ New Note" affordance on a patient chart links to
 * `/notes/new?patientId=...`; the New Note page consumes that query
 * parameter as the initial value of its Patient `<select>`.
 *
 * Two behaviours are exercised:
 *   1. When `useSearchParams()` returns a `patientId`, the Patient
 *      dropdown's initial value equals that id (deep-linked pre-fill).
 *   2. When `useSearchParams()` returns no `patientId`, the dropdown
 *      defaults to the empty-string placeholder option.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// ---------------------------------------------------------------------
// Mutable mocks
// ---------------------------------------------------------------------

let mockPatientIdParam: string | null = null;

const { patients } = vi.hoisted(() => ({
  patients: [
    { id: "fixture-uuid", name: "Jane Doe", mrn: "MRN-0001" },
    { id: "other-uuid", name: "John Smith", mrn: "MRN-0002" },
  ],
}));

// AuthGuard pass-through.
vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Authenticated user so the form renders unconditionally.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "physician", name: "Dr. Smith" },
  }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "patientId" ? mockPatientIdParam : null),
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Permissive tRPC mock: stub patients.list with our fixture; leave the
// template + mutation hooks idle (loading=true) so we don't have to
// render the template body.
vi.mock("@/lib/trpc", () => {
  const proxyFor = (path: string): unknown => {
    if (path === "patients.list") {
      return {
        useQuery: () => ({ data: patients, isLoading: false, isError: false }),
      };
    }
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

import NewNotePage from "../../app/notes/new/page";

beforeEach(() => {
  mockPatientIdParam = null;
});

afterEach(() => {
  cleanup();
});

describe("/notes/new initializes Patient dropdown from ?patientId (#1276)", () => {
  // The page's two <select>s aren't wired to their <label>s via htmlFor,
  // so we identify the Patient one by the "Select a patient..." option
  // text it always renders.
  function getPatientSelect(): HTMLSelectElement {
    const placeholder = screen.getByText("Select a patient...");
    const select = placeholder.closest("select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("Could not find Patient <select> element");
    }
    return select;
  }

  it("uses the search-param patientId as the initial select value", () => {
    mockPatientIdParam = "fixture-uuid";

    render(<NewNotePage />);

    const patientSelect = getPatientSelect();
    expect(patientSelect.value).toBe("fixture-uuid");
  });

  it("defaults to the empty placeholder when no patientId param is present", () => {
    mockPatientIdParam = null;

    render(<NewNotePage />);

    const patientSelect = getPatientSelect();
    expect(patientSelect.value).toBe("");
  });
});
