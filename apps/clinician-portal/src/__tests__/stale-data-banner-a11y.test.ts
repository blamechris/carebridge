import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #525: StaleDataBanner must use role="status" (polite live
 * region), not role="alert" (assertive). role="alert" interrupts a
 * screen-reader mid-sentence, and stale-data context is informational
 * — the clinician should notice it but does NOT need their current
 * reading preempted every time they open a patient chart with
 * week-old data. role="alert" is reserved for genuine errors
 * (see ErrorState) and clinical safety-critical warnings.
 *
 * This is a source-level guard that verifies the extracted
 * StaleDataBanner component file. Render-based a11y assertions live
 * in stale-data-banner.test.tsx (issue #577).
 */
describe("StaleDataBanner accessibility (#525)", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const componentPath = resolve(
    __dirname,
    "../components/stale-data-banner.tsx",
  );
  const src = readFileSync(componentPath, "utf8");

  /**
   * Strip comments (both single-line and block) so a narrative mention
   * of role="alert" inside a documentation comment doesn't cause the
   * negative assertion to flip. We only want to match JSX attribute usage.
   */
  function componentJsx(): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  it("uses role=\"status\" for the stale-data container", () => {
    expect(componentJsx()).toMatch(/role="status"/);
  });

  it("does not use role=\"alert\" as a JSX prop (would preempt the screen reader)", () => {
    expect(componentJsx()).not.toMatch(/role="alert"/);
  });

  it("declares aria-live=\"polite\" explicitly for AT compatibility", () => {
    // role="status" implies aria-live="polite" per ARIA, but naming
    // it explicitly is defensive in case any assistive tech doesn't
    // derive the live-region mapping from role alone.
    expect(componentJsx()).toMatch(/aria-live="polite"/);
  });
});
