/**
 * @vitest-environment jsdom
 *
 * Issue #1306 — collapsible body-system grouping for the SOAP Subjective
 * checkboxes. These tests pin the rendering contract of the reusable
 * GroupedMultiselect component:
 *
 *   1. Section order follows BODY_SYSTEM_ORDER (Neurological,
 *      Cardiovascular, Respiratory, Gastrointestinal, Constitutional)
 *      with anything else sorted alphabetically after.
 *   2. defaultExpanded=true renders every section expanded; the option
 *      grids are visible and the count badge is hidden.
 *   3. defaultExpanded=false collapses every section by default and a
 *      "(N)" count badge appears next to systems with ticked items.
 *   4. Clicking a header toggles the section's expanded state via the
 *      onToggleSection callback.
 *   5. Linked options render a 🔗 icon next to the row label, and
 *      clicking that icon dispatches onUnlink with the bare option.
 */
import React, { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

import {
  type BodySystem,
  getSymptomSystem,
  parseROSOption,
} from "@/lib/symptom-systems";
import { GroupedMultiselect } from "../components/grouped-multiselect";

// Wrapper that lets us drive the controlled collapsed/selected state
// from inside the test, so we exercise the same code paths the real
// NewNoteContent uses.
function Harness({
  options,
  initiallySelected = [],
  defaultExpanded,
  linkedOptions,
  onUnlink,
  fieldKey = "new_symptoms",
}: {
  options: string[];
  initiallySelected?: string[];
  defaultExpanded: boolean;
  linkedOptions?: Set<string>;
  onUnlink?: (opt: string) => void;
  fieldKey?: string;
}) {
  const [selected, setSelected] = useState<string[]>(initiallySelected);
  const [collapsed, setCollapsed] = useState<
    Partial<Record<BodySystem, boolean>>
  >({});
  return (
    <GroupedMultiselect
      fieldKey={fieldKey}
      options={options}
      selected={selected}
      onChange={setSelected}
      groupOf={
        fieldKey === "ros"
          ? (o) => {
              const p = parseROSOption(o);
              return { system: p.system, display: p.symptom };
            }
          : (o) => ({ system: getSymptomSystem(o), display: o })
      }
      collapsed={collapsed}
      onToggleSection={(s) =>
        setCollapsed((prev) => {
          const cur =
            prev[s] !== undefined ? prev[s]! : !defaultExpanded;
          return { ...prev, [s]: !cur };
        })
      }
      defaultExpanded={defaultExpanded}
      linkedOptions={linkedOptions}
      onUnlink={onUnlink}
    />
  );
}

const NS_OPTIONS = [
  "headache",
  "dizziness",
  "chest pain",
  "cough",
  "nausea",
  "fever",
];

const ROS_OPTIONS = [
  "constitutional: fever",
  "cardiovascular: chest pain",
  "respiratory: cough",
  "gastrointestinal: nausea",
  "neurological: headache",
];

describe("GroupedMultiselect (issue #1306)", () => {
  afterEach(() => cleanup());

  it("renders body-system sections in canonical order (Neuro → Cardio → Resp → GI → Constitutional)", () => {
    render(<Harness options={NS_OPTIONS} defaultExpanded={true} />);
    const headings = screen
      .getAllByRole("button", { expanded: true })
      .map((b) => b.textContent?.replace(/[▾▸]\s*/g, "").trim() ?? "");
    expect(headings).toEqual([
      "Neurological",
      "Cardiovascular",
      "Respiratory",
      "Gastrointestinal",
      "Constitutional",
    ]);
  });

  it("defaults to ALL EXPANDED when defaultExpanded=true (New Symptoms)", () => {
    render(<Harness options={NS_OPTIONS} defaultExpanded={true} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(5);
    for (const b of buttons) {
      expect(b.getAttribute("aria-expanded")).toBe("true");
      expect(b.textContent?.startsWith("▾")).toBe(true);
    }
  });

  it("defaults to ALL COLLAPSED when defaultExpanded=false (Review of Systems)", () => {
    render(
      <Harness
        options={ROS_OPTIONS}
        defaultExpanded={false}
        fieldKey="ros"
      />,
    );
    const buttons = screen.getAllByRole("button");
    for (const b of buttons) {
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(b.textContent?.startsWith("▸")).toBe(true);
    }
    // No option region is visible.
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("displays (N) count next to collapsed sections with ticked items", () => {
    render(
      <Harness
        options={ROS_OPTIONS}
        initiallySelected={[
          "constitutional: fever",
          "neurological: headache",
        ]}
        defaultExpanded={false}
        fieldKey="ros"
      />,
    );
    // Section labels include the count for systems with selections.
    const constitutional = screen.getByRole("button", {
      name: /Constitutional/,
    });
    expect(constitutional.textContent).toMatch(/\(1\)/);
    const neuro = screen.getByRole("button", { name: /Neurological/ });
    expect(neuro.textContent).toMatch(/\(1\)/);
    // Sections without ticked items do not show the badge.
    const respiratory = screen.getByRole("button", { name: /Respiratory/ });
    expect(respiratory.textContent).not.toMatch(/\(/);
  });

  it("toggles expand/collapse when the header is clicked", () => {
    render(<Harness options={NS_OPTIONS} defaultExpanded={true} />);
    const neuro = screen.getByRole("button", { name: /Neurological/ });
    expect(neuro.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(neuro);
    expect(neuro.getAttribute("aria-expanded")).toBe("false");
    expect(neuro.textContent?.startsWith("▸")).toBe(true);

    fireEvent.click(neuro);
    expect(neuro.getAttribute("aria-expanded")).toBe("true");
    expect(neuro.textContent?.startsWith("▾")).toBe(true);
  });

  it("renders the 🔗 icon next to linked options and dispatches onUnlink when clicked", () => {
    const onUnlink = vi.fn();
    render(
      <Harness
        options={NS_OPTIONS}
        initiallySelected={["headache"]}
        defaultExpanded={true}
        linkedOptions={new Set(["headache"])}
        onUnlink={onUnlink}
      />,
    );
    const unlinkBtn = screen.getByRole("button", {
      name: /Unlink headache/i,
    });
    expect(unlinkBtn).toBeTruthy();
    fireEvent.click(unlinkBtn);
    expect(onUnlink).toHaveBeenCalledWith("headache");
  });

  it("does not render the 🔗 icon for non-linked checked rows", () => {
    render(
      <Harness
        options={NS_OPTIONS}
        initiallySelected={["headache", "dizziness"]}
        defaultExpanded={true}
        linkedOptions={new Set(["headache"])}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Unlink headache/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Unlink dizziness/i }),
    ).toBeNull();
  });

  it("uses the parsed ROS suffix as the row label", () => {
    render(
      <Harness
        options={ROS_OPTIONS}
        defaultExpanded={true}
        fieldKey="ros"
      />,
    );
    // The Neurological section row should read 'headache', not
    // 'neurological: headache'.
    const neuroRegion = screen
      .getByRole("button", { name: /Neurological/ })
      .nextElementSibling;
    expect(neuroRegion).toBeTruthy();
    expect(within(neuroRegion as HTMLElement).getByText("headache")).toBeTruthy();
  });
});
