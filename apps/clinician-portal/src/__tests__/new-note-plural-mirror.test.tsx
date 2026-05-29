/**
 * @vitest-environment jsdom
 *
 * Issue #1314 — integration: NS "vision changes" should auto-mirror to
 * ROS "eyes: vision change" through the page-level handler, exercising
 * the normalised matcher introduced for this issue.
 *
 * The shared SOAP template (`@carebridge/shared-types/notes`) has NS
 * "vision changes" (plural) and the ROS catalog uses "eyes: vision
 * change" (singular). Before this fix, the bare exact-match auto-mirror
 * silently dropped the pairing because "changes" !== "change".
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";

type StubField = {
  key: string;
  label: string;
  value: string | string[] | boolean | number | null;
  field_type:
    | "text"
    | "textarea"
    | "select"
    | "multiselect"
    | "checkbox"
    | "number";
  source: "new_entry" | "carried_forward" | "modified";
  options?: string[];
};

// Minimal template focused on the plural-drift case.
const NS_OPTIONS = ["vision changes", "tingling", "headache"];
const ROS_OPTIONS = [
  "eyes: vision change",
  "neurological: headache",
];

const TEMPLATE: { key: string; label: string; fields: StubField[] }[] = [
  {
    key: "subjective",
    label: "Subjective",
    fields: [
      {
        key: "new_symptoms",
        label: "New Symptoms",
        value: [],
        field_type: "multiselect",
        source: "new_entry",
        options: NS_OPTIONS,
      },
      {
        key: "ros",
        label: "Review of Systems",
        value: [],
        field_type: "multiselect",
        source: "new_entry",
        options: ROS_OPTIONS,
      },
    ],
  },
];

vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "physician", name: "T" } }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/trpc", () => {
  const trpc = {
    patients: {
      list: {
        useQuery: () => ({ data: [], isLoading: false, isError: false }),
      },
    },
    notes: {
      templates: {
        get: {
          useQuery: () => ({
            data: TEMPLATE,
            isLoading: false,
            isError: false,
          }),
        },
      },
      create: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: null,
        }),
      },
    },
  };
  return { trpc };
});

import NewNotePage from "../../app/notes/new/page";

beforeEach(() => {
  for (const section of TEMPLATE) {
    for (const f of section.fields) {
      if (f.field_type === "multiselect") f.value = [];
    }
  }
  localStorage.clear();
});

afterEach(() => cleanup());

function getFieldRoot(fieldKey: string): HTMLElement {
  const el = document.querySelector(`[data-field-key="${fieldKey}"]`);
  if (!el) throw new Error(`No grouped multiselect for ${fieldKey}`);
  return el as HTMLElement;
}

function getHeader(
  fieldKey: string,
  systemLabel: RegExp | string,
): HTMLButtonElement {
  const root = getFieldRoot(fieldKey);
  return within(root).getByRole("button", {
    name: systemLabel,
  }) as HTMLButtonElement;
}

function getOptionCheckbox(
  fieldKey: string,
  rowLabel: string,
): HTMLInputElement {
  const root = getFieldRoot(fieldKey);
  const labelEl = within(root)
    .getByText(rowLabel, { exact: true })
    .closest("label");
  if (!labelEl)
    throw new Error(`No row labelled ${rowLabel} under ${fieldKey}`);
  const cb = labelEl.querySelector('input[type="checkbox"]');
  if (!cb) throw new Error(`No checkbox in row ${rowLabel}`);
  return cb as HTMLInputElement;
}

describe("/notes/new — NS↔ROS plural drift (#1314)", () => {
  it("ticking NS 'vision changes' auto-mirrors ROS 'eyes: vision change'", () => {
    render(<NewNotePage />);
    fireEvent.click(getHeader("ros", /Eyes/));

    const nsBox = getOptionCheckbox("new_symptoms", "vision changes");
    fireEvent.click(nsBox);

    // ROS "vision change" got auto-ticked despite the singular/plural
    // mismatch.
    expect(
      getOptionCheckbox("ros", "vision change").checked,
    ).toBe(true);
  });

  it("ticking ROS 'eyes: vision change' auto-mirrors NS 'vision changes'", () => {
    render(<NewNotePage />);
    fireEvent.click(getHeader("ros", /Eyes/));

    fireEvent.click(getOptionCheckbox("ros", "vision change"));

    expect(
      getOptionCheckbox("new_symptoms", "vision changes").checked,
    ).toBe(true);
  });

  it("distinctive NS symptom with no ROS counterpart does not error", () => {
    render(<NewNotePage />);

    // NS "tingling" has no ROS counterpart. Ticking it should be a
    // no-op on the ROS side — no error, no spurious matches. We rely
    // on (a) the click not throwing, and (b) all ROS sections still
    // reporting aria-expanded="false" with no (N) count badge (i.e.
    // nothing got auto-ticked).
    expect(() => {
      fireEvent.click(getOptionCheckbox("new_symptoms", "tingling"));
    }).not.toThrow();

    const rosRoot = getFieldRoot("ros");
    const rosButtons = within(rosRoot).getAllByRole("button");
    for (const b of rosButtons) {
      // No section gained a count badge from a spurious mirror.
      expect(b.textContent).not.toMatch(/\(/);
    }
  });
});
