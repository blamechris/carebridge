/**
 * @vitest-environment jsdom
 *
 * Bundle of regression tests for the post-#1310 polish work:
 *
 *   - #1312 — 🔗 unlink button must meet WCAG 2.5.5 (44×44 hit area).
 *     jsdom doesn't compute layout, so we assert the inline style
 *     declares min-width / min-height ≥ 44px.
 *   - #1313 — the GroupedMultiselect mobile breakpoint must use the
 *     portal-standard 767px instead of the ad-hoc 599px the PR
 *     originally shipped with.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { GroupedMultiselect } from "../components/grouped-multiselect";
import {
  type BodySystem,
  getSymptomSystem,
} from "../lib/symptom-systems";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = resolve(__dirname, "../../app/globals.css");

afterEach(() => cleanup());

describe("🔗 unlink button hit area (#1312)", () => {
  it("declares min-width and min-height ≥ 44px on the unlink button", () => {
    const onUnlink = vi.fn();
    const collapsed: Partial<Record<BodySystem, boolean>> = {};
    render(
      <GroupedMultiselect
        fieldKey="new_symptoms"
        options={["headache"]}
        selected={["headache"]}
        onChange={() => {}}
        groupOf={(o) => ({ system: getSymptomSystem(o), display: o })}
        collapsed={collapsed}
        onToggleSection={() => {}}
        defaultExpanded={true}
        linkedOptions={new Set(["headache"])}
        onUnlink={onUnlink}
      />,
    );
    const btn = screen.getByRole("button", {
      name: /Unlink headache/i,
    }) as HTMLButtonElement;
    // The inline style on the button must declare a 44px floor on BOTH
    // dimensions. We read the literal style attribute because jsdom
    // does not compute layout boxes.
    const style = btn.getAttribute("style") ?? "";
    expect(style).toMatch(/min-width:\s*44px/);
    expect(style).toMatch(/min-height:\s*44px/);
  });

  it("is centered so the visible 🔗 doesn't grow with the hit area", () => {
    const onUnlink = vi.fn();
    render(
      <GroupedMultiselect
        fieldKey="new_symptoms"
        options={["headache"]}
        selected={["headache"]}
        onChange={() => {}}
        groupOf={(o) => ({ system: getSymptomSystem(o), display: o })}
        collapsed={{}}
        onToggleSection={() => {}}
        defaultExpanded={true}
        linkedOptions={new Set(["headache"])}
        onUnlink={onUnlink}
      />,
    );
    const btn = screen.getByRole("button", { name: /Unlink headache/i });
    const style = btn.getAttribute("style") ?? "";
    // align-items / justify-content centering keeps the emoji visually
    // small inside the 44×44 hit area.
    expect(style).toMatch(/align-items:\s*center/);
    expect(style).toMatch(/justify-content:\s*center/);
  });
});

describe("GroupedMultiselect mobile breakpoint (#1313)", () => {
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

  it("no longer uses the ad-hoc 599px breakpoint for grouped-multiselect-options", () => {
    // Find the .grouped-multiselect-options rule body and verify it
    // sits under the 767px block, NOT under a 599px block.
    expect(css).not.toMatch(
      /@media\s*\(\s*max-width:\s*599px\s*\)\s*\{[^}]*grouped-multiselect-options/s,
    );
  });

  it("uses the portal-standard 767px breakpoint for the grouped-multiselect stacking rule", () => {
    // The .grouped-multiselect-options column-stack rule must live
    // inside one of the existing 767px blocks.
    const pattern =
      /@media\s*\(\s*max-width:\s*767px\s*\)\s*\{[\s\S]*?\.grouped-multiselect-options\s*\{[\s\S]*?flex-direction:\s*column[\s\S]*?\}/;
    expect(css).toMatch(pattern);
  });
});
