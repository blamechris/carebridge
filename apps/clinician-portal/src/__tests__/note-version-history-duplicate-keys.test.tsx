/**
 * @vitest-environment jsdom
 *
 * Issue #1273 — guard the Version History block on the note detail page
 * against the duplicate-React-key regression fixed in PR #1268.
 *
 * Sign and cosign both archive the pre-transition note at
 * `existing.version` without bumping the integer (only amendments bump
 * it). That means two rows in `versions` can share the same numeric
 * `version` and are disambiguated by `lifecycle_event`. Using
 * `key={v.version}` was therefore unsafe and triggered React's
 * "Encountered two children with the same key" warning. The fix uses
 * a composite key — `${version}-${lifecycle_event}-${saved_at}`.
 *
 * This test renders the note detail page with mocked tRPC data
 * containing two version rows that share `version: 2` (one `signed`,
 * one `cosigned`) and asserts:
 *
 *   1. React emits NO duplicate-key warning to console.error.
 *   2. Both rows actually render in the DOM (i.e. React reconciliation
 *      did not collapse them).
 *
 * If a future refactor reverts `key` back to `v.version` alone, the
 * console.error spy will catch the warning and this test will fail.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// ---------------------------------------------------------------------
// Mocks — these must be declared before the SUT import below.
// ---------------------------------------------------------------------

// AuthGuard pass-through so NoteDetailContent renders directly.
vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// A simple physician user; the Sign button only shows on draft notes
// and our fixture is "signed", so the user payload is only consulted
// for the `canSign` guard.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "physician", name: "Dr. T" } }),
}));

// next/navigation — useParams returns the note id we will key the
// mocked getById query off of.
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "note-1" }),
}));

// next/link — simple passthrough so we don't drag the Next router in.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

// ---------------------------------------------------------------------
// Note fixture with TWO version rows that share version: 2.
// One row is the original sign, the other is the cosign — both archive
// at the same numeric version, distinguished only by lifecycle_event.
//
// Hoisted via vi.hoisted so the fixtures exist before vi.mock factories
// (which Vitest hoists above any non-hoisted const) reference them.
// ---------------------------------------------------------------------
const { noteFixture, patientFixture } = vi.hoisted(() => ({
  noteFixture: {
    note: {
      id: "note-1",
      patient_id: "patient-1",
      provider_id: "prov-1",
      template_type: "soap",
      status: "cosigned",
      version: 2,
      sections: [],
      created_at: "2026-05-01T10:00:00.000Z",
      signed_at: "2026-05-01T11:00:00.000Z",
      signed_by: "prov-1",
    },
    versions: [
      {
        note_id: "note-1",
        version: 2,
        sections: [],
        saved_at: "2026-05-01T11:00:00.000Z",
        saved_by: "prov-1",
        lifecycle_event: "signed",
      },
      {
        note_id: "note-1",
        version: 2,
        sections: [],
        saved_at: "2026-05-01T12:30:00.000Z",
        saved_by: "prov-2",
        lifecycle_event: "cosigned",
      },
    ],
  },
  patientFixture: {
    id: "patient-1",
    name: "Jane Doe",
    mrn: "MRN-0001",
  },
}));

vi.mock("@/lib/trpc", () => {
  const stubQuery = <T,>(data: T) => ({
    useQuery: () => ({ data, isLoading: false, isError: false }),
  });

  return {
    trpc: {
      useUtils: () => ({
        notes: {
          getById: { invalidate: vi.fn().mockResolvedValue(undefined) },
        },
      }),
      notes: {
        getById: stubQuery(noteFixture),
        sign: {
          useMutation: () => ({
            mutate: vi.fn(),
            isPending: false,
            isError: false,
          }),
        },
      },
      patients: {
        getById: stubQuery(patientFixture),
      },
    },
  };
});

// SUT is imported AFTER the mocks above are registered.
import NoteDetailPage from "../../app/notes/[id]/page";

// ---------------------------------------------------------------------
// Console.error spy — catches React's duplicate-key warning.
// ---------------------------------------------------------------------
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe("Note detail — version history duplicate-version rows (#1273)", () => {
  it("renders both rows that share the same version int without a duplicate-key warning", () => {
    render(<NoteDetailPage />);

    // 1) Version History block is present.
    expect(screen.getByText(/Version History/i)).toBeInTheDocument();

    // 2) Both v2 rows render — React did NOT collapse them. Querying
    //    by role/label of the label cells is brittle because both
    //    display "v2"; instead use getAllByText to assert the count.
    const versionLabels = screen.getAllByText("v2");
    // One v2 label is the metadata block ("Version: v2"); two more
    // are the history rows. So we expect 3 occurrences total.
    expect(versionLabels.length).toBe(3);

    // 3) The cosign row's saved_by value renders — proving the second
    //    row is a real DOM node and not deduped to the first by React.
    //    `prov-1` shows up in multiple places (note Author, Signed by,
    //    sign history row) so we anchor on the unique `prov-2` value.
    expect(screen.getByText(/prov-2/)).toBeInTheDocument();
    expect(screen.getAllByText(/prov-1/).length).toBeGreaterThanOrEqual(1);

    // 4) Most importantly — no duplicate-key warning was emitted.
    const dupKeyCalls = errorSpy.mock.calls.filter((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /Encountered two children with the same key/i.test(a),
      ),
    );
    expect(dupKeyCalls).toEqual([]);
  });
});
