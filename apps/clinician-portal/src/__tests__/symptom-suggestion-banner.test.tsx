/**
 * @vitest-environment jsdom
 *
 * Issue #1305 — symptom suggestion banner driven by Chief Complaint text.
 *
 * Two layers under test:
 *
 *   1. The standalone `SymptomSuggestionBanner` + `detectSuggestions`
 *      pair. Verifies bare matches, negation, plurals, comma cascade,
 *      mixed positive/negative content, and the dismiss-stickiness
 *      contract.
 *
 *   2. End-to-end wiring inside NewNotePage (mounted against the stub
 *      trpc template used by the symptom-mirror test). Verifies the
 *      banner renders above the NS multiselect, "Tick all suggested"
 *      ticks every suggested option (and re-uses the NS↔ROS auto-mirror
 *      from #1306), and the inline `[suggested]` highlight appears on
 *      the matching checkbox row.
 */
import React, { useState } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";

import {
  detectSuggestions,
  SymptomSuggestionBanner,
} from "../components/symptom-suggestion-banner";

const NS_OPTIONS = [
  // Subset of the real SOAP template (#1305). Includes plurals worth
  // probing ("headache" + "fever" + "nausea").
  "headache",
  "dizziness",
  "numbness",
  "chest pain",
  "nausea",
  "fever",
  "fatigue",
  "shortness of breath",
];

// ----------------------------------------------------------------------
// Layer 1: pure detection + standalone banner
// ----------------------------------------------------------------------

describe("detectSuggestions (issue #1305)", () => {
  it("detects a bare positive mention", () => {
    expect(
      detectSuggestions("New onset severe headache, 8/10.", NS_OPTIONS),
    ).toContain("headache");
  });

  it("does not suggest a negated symptom", () => {
    expect(detectSuggestions("no headache", NS_OPTIONS)).not.toContain(
      "headache",
    );
  });

  it("detects a plural form (headaches → headache)", () => {
    expect(
      detectSuggestions("patient has headaches today", NS_OPTIONS),
    ).toContain("headache");
  });

  it("respects negation against the plural form (no headaches → no suggestion)", () => {
    expect(
      detectSuggestions("no headaches in two weeks", NS_OPTIONS),
    ).not.toContain("headache");
  });

  it("suppresses comma-cascade negatives ('no fever, no nausea')", () => {
    const out = detectSuggestions("no fever, no nausea", NS_OPTIONS);
    expect(out).not.toContain("fever");
    expect(out).not.toContain("nausea");
  });

  it("mixes positive and negative: only the positive surfaces", () => {
    const out = detectSuggestions("headache and no fever", NS_OPTIONS);
    expect(out).toContain("headache");
    expect(out).not.toContain("fever");
  });

  it("supports the full DVT-scenario CC ('severe headache' + 'numbness')", () => {
    const out = detectSuggestions(
      "New onset severe headache, 8/10. Numbness in left arm.",
      NS_OPTIONS,
    );
    expect(out).toEqual(expect.arrayContaining(["headache", "numbness"]));
  });

  it("returns [] for empty CC text", () => {
    expect(detectSuggestions("", NS_OPTIONS)).toEqual([]);
  });
});

// ----------------------------------------------------------------------
// Layer 1b: banner rendering + dismiss + tick-all callbacks
// ----------------------------------------------------------------------

function BannerHarness({
  initialChiefComplaint,
  initiallyTicked = [],
}: {
  initialChiefComplaint: string;
  initiallyTicked?: string[];
}) {
  const [cc, setCc] = useState(initialChiefComplaint);
  const [ticked, setTicked] = useState<string[]>(initiallyTicked);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  return (
    <>
      <textarea
        data-testid="cc"
        value={cc}
        onChange={(e) => setCc(e.target.value)}
      />
      <SymptomSuggestionBanner
        chiefComplaintText={cc}
        allSymptomOptions={NS_OPTIONS}
        currentlyTicked={ticked}
        dismissedForText={dismissedFor}
        onTickAll={(suggestions) => {
          const next = [...ticked];
          for (const s of suggestions) if (!next.includes(s)) next.push(s);
          setTicked(next);
        }}
        onDismiss={(text) => setDismissedFor(text)}
      />
      <div data-testid="ticked">{ticked.join(",")}</div>
    </>
  );
}

describe("SymptomSuggestionBanner — render + interactions (#1305)", () => {
  afterEach(() => cleanup());

  it("renders the banner with the detected list", () => {
    render(
      <BannerHarness initialChiefComplaint="severe headache and numbness" />,
    );
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();
    expect(
      screen.getByTestId("symptom-suggestion-list").textContent,
    ).toMatch(/headache/);
    expect(
      screen.getByTestId("symptom-suggestion-list").textContent,
    ).toMatch(/numbness/);
  });

  it("hides the banner when nothing is detected", () => {
    render(<BannerHarness initialChiefComplaint="patient feels well" />);
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();
  });

  it("hides the banner when every detected suggestion is already ticked", () => {
    render(
      <BannerHarness
        initialChiefComplaint="severe headache"
        initiallyTicked={["headache"]}
      />,
    );
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();
  });

  it("'Tick all suggested' batch-ticks every banner item", () => {
    render(
      <BannerHarness initialChiefComplaint="severe headache and numbness" />,
    );
    fireEvent.click(screen.getByTestId("symptom-suggestion-tick-all"));
    expect(screen.getByTestId("ticked").textContent).toMatch(
      /headache.*numbness|numbness.*headache/,
    );
  });

  it("'Tick all' respects items already ticked (no un-tick)", () => {
    render(
      <BannerHarness
        initialChiefComplaint="severe headache and numbness"
        initiallyTicked={["fever"]}
      />,
    );
    fireEvent.click(screen.getByTestId("symptom-suggestion-tick-all"));
    const list = screen.getByTestId("ticked").textContent ?? "";
    expect(list).toContain("fever");
    expect(list).toContain("headache");
    expect(list).toContain("numbness");
  });

  it("'Dismiss' hides the banner; typing in CC re-renders it; identical text after dismiss stays hidden", () => {
    render(
      <BannerHarness initialChiefComplaint="severe headache" />,
    );
    // Initial render shows the banner.
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();

    fireEvent.click(screen.getByTestId("symptom-suggestion-dismiss"));
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();

    // Typing a NEW symptom in CC re-renders the banner (different text
    // → dismissal no longer matches).
    fireEvent.change(screen.getByTestId("cc"), {
      target: { value: "severe headache and numbness" },
    });
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();

    // Reverting the text to the originally-dismissed string hides the
    // banner again because the dismissal is keyed to that exact text.
    fireEvent.change(screen.getByTestId("cc"), {
      target: { value: "severe headache" },
    });
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();
  });
});

// ----------------------------------------------------------------------
// Layer 2: end-to-end wiring against NewNotePage + GroupedMultiselect.
// ----------------------------------------------------------------------

const ROS_OPTIONS_E2E = [
  "constitutional: fever",
  "constitutional: fatigue",
  "cardiovascular: chest pain",
  "respiratory: cough",
  "gastrointestinal: nausea",
  "neurological: headache",
  "neurological: dizziness",
  "neurological: numbness",
];

const NS_OPTIONS_E2E = [
  "headache",
  "dizziness",
  "numbness",
  "chest pain",
  "cough",
  "nausea",
  "fever",
  "fatigue",
];

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

const TEMPLATE_E2E: { key: string; label: string; fields: StubField[] }[] = [
  {
    key: "subjective",
    label: "Subjective",
    fields: [
      {
        key: "chief_complaint",
        label: "Chief Complaint",
        value: "",
        field_type: "text",
        source: "new_entry",
      },
      {
        key: "new_symptoms",
        label: "New Symptoms",
        value: [],
        field_type: "multiselect",
        source: "new_entry",
        options: NS_OPTIONS_E2E,
      },
      {
        key: "ros",
        label: "Review of Systems",
        value: [],
        field_type: "multiselect",
        source: "new_entry",
        options: ROS_OPTIONS_E2E,
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
            data: TEMPLATE_E2E,
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
  // Reset template values so each test starts clean.
  for (const section of TEMPLATE_E2E) {
    for (const f of section.fields) {
      if (f.field_type === "multiselect") f.value = [];
      if (f.key === "chief_complaint") f.value = "";
    }
  }
});

afterEach(() => cleanup());

function getFieldRoot(fieldKey: string): HTMLElement {
  const el = document.querySelector(`[data-field-key="${fieldKey}"]`);
  if (!el) throw new Error(`No grouped multiselect for ${fieldKey}`);
  return el as HTMLElement;
}

function getOptionCheckbox(
  fieldKey: string,
  rowLabel: string,
): HTMLInputElement {
  const root = getFieldRoot(fieldKey);
  const labelEl = within(root)
    .getByText(rowLabel, { exact: true })
    .closest("label");
  if (!labelEl) throw new Error(`No row labelled ${rowLabel} under ${fieldKey}`);
  const cb = labelEl.querySelector('input[type="checkbox"]');
  if (!cb) throw new Error(`No checkbox in row ${rowLabel}`);
  return cb as HTMLInputElement;
}

function getChiefComplaintInput(): HTMLInputElement {
  // The "text" field type renders as an <input type="text"> via FieldInput.
  // It is the only such input on the page in the stub template.
  const label = screen.getByText("Chief Complaint");
  const row = label.closest(".detail-row");
  if (!row) throw new Error("No CC row");
  const input = row.querySelector('input[type="text"]');
  if (!input) throw new Error("No CC input");
  return input as HTMLInputElement;
}

describe("/notes/new — symptom suggestion banner integration (#1305)", () => {
  it("renders the banner above New Symptoms when CC mentions a symptom", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache today" },
    });
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();
    expect(
      screen.getByTestId("symptom-suggestion-list").textContent,
    ).toMatch(/headache/);
  });

  it("does not render the banner when CC is empty", () => {
    render(<NewNotePage />);
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();
  });

  it("does not render the banner when the only mention is negated", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "no headache" },
    });
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();
  });

  it("inline highlight: suggested NS checkbox gets [suggested] label + data-suggested attr", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache" },
    });

    const headacheLabel = within(getFieldRoot("new_symptoms"))
      .getByText("headache", { exact: true })
      .closest("label");
    expect(headacheLabel).toBeTruthy();
    expect(headacheLabel?.getAttribute("data-suggested")).toBe("true");
    expect(
      within(getFieldRoot("new_symptoms")).getByText("[suggested]"),
    ).toBeTruthy();
  });

  it("highlight disappears the moment the suggested item is ticked", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache" },
    });
    // Sanity: highlight present.
    const headacheLabelBefore = within(getFieldRoot("new_symptoms"))
      .getByText("headache", { exact: true })
      .closest("label");
    expect(headacheLabelBefore?.getAttribute("data-suggested")).toBe("true");

    fireEvent.click(getOptionCheckbox("new_symptoms", "headache"));

    const headacheLabelAfter = within(getFieldRoot("new_symptoms"))
      .getByText("headache", { exact: true })
      .closest("label");
    expect(headacheLabelAfter?.getAttribute("data-suggested")).toBeNull();
  });

  it("'Tick all suggested' batch-ticks every suggestion and triggers the NS↔ROS auto-mirror", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache and numbness, no fever" },
    });

    fireEvent.click(screen.getByTestId("symptom-suggestion-tick-all"));

    expect(getOptionCheckbox("new_symptoms", "headache").checked).toBe(true);
    expect(getOptionCheckbox("new_symptoms", "numbness").checked).toBe(true);
    expect(getOptionCheckbox("new_symptoms", "fever").checked).toBe(false);

    // ROS auto-mirror — the Neurological section was collapsed on
    // mount, so the count badge should reflect both ticks.
    const rosNeuro = within(getFieldRoot("ros")).getByRole("button", {
      name: /Neurological/,
    });
    expect(rosNeuro.textContent).toMatch(/\(2\)/);
  });

  it("Dismiss hides the banner; typing fresh symptoms re-renders it", () => {
    render(<NewNotePage />);
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache" },
    });
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();

    fireEvent.click(screen.getByTestId("symptom-suggestion-dismiss"));
    expect(
      screen.queryByTestId("symptom-suggestion-banner"),
    ).toBeNull();

    // Adding "numbness" surfaces the banner again because the CC text
    // changed (dismissal was keyed to the previous text).
    fireEvent.change(getChiefComplaintInput(), {
      target: { value: "severe headache and numbness" },
    });
    expect(screen.getByTestId("symptom-suggestion-banner")).toBeTruthy();
  });
});
