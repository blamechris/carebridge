/**
 * @vitest-environment jsdom
 *
 * Issue #1306 — NS ↔ ROS auto-mirror integration on /notes/new.
 *
 * These tests mount the real NewNotePage with a stub trpc that hands
 * back a SOAP-shaped template containing the two multiselect fields,
 * then drive the page through realistic interactions:
 *
 *   1. Captions appear under the NS and ROS field labels.
 *   2. NS defaults to fully expanded; ROS defaults to fully collapsed.
 *   3. Ticking a NS option (headache) auto-ticks the matching ROS
 *      option ("neurological: headache") and a 🔗 indicator renders
 *      next to BOTH rows.
 *   4. Clicking the 🔗 icon unlinks the pair: the icon disappears, and
 *      subsequent ticks/unticks on either side no longer mirror.
 *   5. Reverse-direction mirror: ticking the ROS row also ticks the
 *      bare NS option, and 🔗 renders on both rows.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";

// ---------------------------------------------------------------------
// Mock state shared across tests. Reset in beforeEach.
// ---------------------------------------------------------------------

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
  "constitutional: fatigue",
  "constitutional: night sweats",
  "cardiovascular: chest pain",
  "respiratory: cough",
  "gastrointestinal: nausea",
  "neurological: headache",
  "neurological: dizziness",
];

const NS_OPTIONS = [
  "headache",
  "dizziness",
  "chest pain",
  "cough",
  "nausea",
  "fever",
  "fatigue",
  "night sweats",
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
  // Reset the templates' top-level value arrays so each test starts
  // from an empty selection. NoteField objects are cloned inside the
  // page when setSections runs, so the parent ref stays stable.
  for (const section of TEMPLATE) {
    for (const f of section.fields) {
      if (f.field_type === "multiselect") f.value = [];
    }
  }
});

afterEach(() => cleanup());

// Helper to find a section header button within either NS or ROS by
// the surrounding `data-field-key` wrapper.
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
  return within(root).getByRole("button", { name: systemLabel }) as HTMLButtonElement;
}

function getOptionCheckbox(
  fieldKey: string,
  rowLabel: string,
): HTMLInputElement {
  const root = getFieldRoot(fieldKey);
  // Row label is the <span> text — locate by visible text and walk
  // up to the surrounding <label>.
  const labelEl = within(root)
    .getByText(rowLabel, { exact: true })
    .closest("label");
  if (!labelEl) throw new Error(`No row labelled ${rowLabel} under ${fieldKey}`);
  const cb = labelEl.querySelector('input[type="checkbox"]');
  if (!cb) throw new Error(`No checkbox in row ${rowLabel}`);
  return cb as HTMLInputElement;
}

describe("/notes/new — NS ↔ ROS auto-mirror (#1306)", () => {
  it("renders captions under both NS and ROS field labels", () => {
    render(<NewNotePage />);
    expect(
      screen.getByText(/Symptoms the patient is reporting today\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Full systems review for the visit/i,
      ),
    ).toBeTruthy();
  });

  it("defaults: NS sections all expanded, ROS sections all collapsed", () => {
    render(<NewNotePage />);

    const nsRoot = getFieldRoot("new_symptoms");
    const nsButtons = within(nsRoot).getAllByRole("button");
    for (const b of nsButtons) {
      expect(b.getAttribute("aria-expanded")).toBe("true");
    }

    const rosRoot = getFieldRoot("ros");
    const rosButtons = within(rosRoot).getAllByRole("button");
    for (const b of rosButtons) {
      expect(b.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("ticking NS 'headache' auto-ticks ROS 'neurological: headache' and shows 🔗 on both rows", () => {
    render(<NewNotePage />);

    // Expand the ROS Neurological section so we can inspect the row.
    fireEvent.click(getHeader("ros", /Neurological/));

    const nsHeadache = getOptionCheckbox("new_symptoms", "headache");
    fireEvent.click(nsHeadache);

    // ROS row got auto-ticked.
    const rosHeadache = getOptionCheckbox("ros", "headache");
    expect(rosHeadache.checked).toBe(true);

    // 🔗 unlink button is present next to BOTH rows.
    const nsRoot = getFieldRoot("new_symptoms");
    const rosRoot = getFieldRoot("ros");
    expect(
      within(nsRoot).getByRole("button", { name: /Unlink headache/i }),
    ).toBeTruthy();
    expect(
      within(rosRoot).getByRole("button", { name: /Unlink headache/i }),
    ).toBeTruthy();
  });

  it("clicking the 🔗 icon unlinks the pair; the icon disappears and future ticks no longer mirror", () => {
    render(<NewNotePage />);
    fireEvent.click(getHeader("ros", /Neurological/));

    fireEvent.click(getOptionCheckbox("new_symptoms", "headache"));

    // Unlink via the NS-side icon.
    const nsRoot = getFieldRoot("new_symptoms");
    const unlinkBtn = within(nsRoot).getByRole("button", {
      name: /Unlink headache/i,
    });
    fireEvent.click(unlinkBtn);

    // 🔗 disappears from both sides.
    expect(
      within(getFieldRoot("new_symptoms")).queryByRole("button", {
        name: /Unlink headache/i,
      }),
    ).toBeNull();
    expect(
      within(getFieldRoot("ros")).queryByRole("button", {
        name: /Unlink headache/i,
      }),
    ).toBeNull();

    // Untick NS — ROS stays checked because the pair is unlinked.
    fireEvent.click(getOptionCheckbox("new_symptoms", "headache"));
    expect(getOptionCheckbox("ros", "headache").checked).toBe(true);
    expect(getOptionCheckbox("new_symptoms", "headache").checked).toBe(false);

    // Re-tick NS — ROS already checked, still no mirror activity, and
    // no 🔗 reappears because the unlinked entry is sticky.
    fireEvent.click(getOptionCheckbox("new_symptoms", "headache"));
    expect(getOptionCheckbox("ros", "headache").checked).toBe(true);
    expect(
      within(getFieldRoot("new_symptoms")).queryByRole("button", {
        name: /Unlink headache/i,
      }),
    ).toBeNull();
  });

  it("reverse-direction mirror: ticking ROS 'constitutional: fever' auto-ticks NS 'fever' and shows 🔗 on both", () => {
    render(<NewNotePage />);
    // Expand the ROS Constitutional section first.
    fireEvent.click(getHeader("ros", /Constitutional/));

    fireEvent.click(getOptionCheckbox("ros", "fever"));

    // NS auto-ticked.
    expect(getOptionCheckbox("new_symptoms", "fever").checked).toBe(true);

    // 🔗 on both rows.
    expect(
      within(getFieldRoot("new_symptoms")).getByRole("button", {
        name: /Unlink fever/i,
      }),
    ).toBeTruthy();
    expect(
      within(getFieldRoot("ros")).getByRole("button", {
        name: /Unlink fever/i,
      }),
    ).toBeTruthy();
  });

  it("collapsed ROS sections show (N) counts after auto-mirroring populates them", () => {
    render(<NewNotePage />);

    // Tick NS headache without expanding the ROS section — ROS
    // remains collapsed but the count badge must surface.
    fireEvent.click(getOptionCheckbox("new_symptoms", "headache"));

    const rosNeuroHeader = getHeader("ros", /Neurological/);
    expect(rosNeuroHeader.getAttribute("aria-expanded")).toBe("false");
    expect(rosNeuroHeader.textContent).toMatch(/\(1\)/);
  });
});
