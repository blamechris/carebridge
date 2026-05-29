/**
 * @vitest-environment jsdom
 *
 * Issue #1311 — integration: collapse state and unlinked-pair state
 * survive a page remount via localStorage. We mount, drive a toggle,
 * unmount, mount again, and assert the previous state is restored.
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

const ROS_OPTIONS = [
  "constitutional: fever",
  "neurological: headache",
];
const NS_OPTIONS = ["fever", "headache"];

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

describe("/notes/new — section collapse persists across remounts (#1311)", () => {
  it("collapsing a NS section persists to localStorage and rehydrates on remount", () => {
    const first = render(<NewNotePage />);
    const nsNeuro = getHeader("new_symptoms", /Neurological/);
    // NS defaults to expanded; collapse it.
    expect(nsNeuro.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(nsNeuro);
    expect(nsNeuro.getAttribute("aria-expanded")).toBe("false");

    first.unmount();

    // Fresh mount — the previously-collapsed Neurological section
    // should still be collapsed.
    render(<NewNotePage />);
    const remountedHeader = getHeader("new_symptoms", /Neurological/);
    expect(remountedHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("expanding a ROS section persists across remounts", () => {
    const first = render(<NewNotePage />);
    const rosNeuro = getHeader("ros", /Neurological/);
    // ROS defaults to collapsed; expand it.
    expect(rosNeuro.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rosNeuro);
    expect(rosNeuro.getAttribute("aria-expanded")).toBe("true");

    first.unmount();

    render(<NewNotePage />);
    const remountedHeader = getHeader("ros", /Neurological/);
    expect(remountedHeader.getAttribute("aria-expanded")).toBe("true");
  });
});
