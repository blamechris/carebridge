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
 * This is a source-level test because StaleDataBanner is not exported
 * from the client-component page module. A future refactor could
 * extract the banner into src/components/ for a render-based assertion;
 * until then we guard the attribute at the file-content level.
 */
describe("StaleDataBanner accessibility (#525)", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pagePath = resolve(
    __dirname,
    "../../app/patients/[id]/page.tsx",
  );
  const src = readFileSync(pagePath, "utf8");

  // Isolate the StaleDataBanner function body so we don't get fooled
  // by `role="alert"` on ErrorState or the flag-severity badge further
  // down the file.
  function staleBannerBody(): string {
    const start = src.indexOf("function StaleDataBanner");
    expect(start).toBeGreaterThan(-1);
    // Find the function's returned JSX — scan until we hit the next
    // top-level `function` declaration.
    const rest = src.slice(start);
    const next = rest.indexOf("\nfunction ", 1);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /**
   * Strip single-line comments so a narrative mention of role="alert"
   * inside a `//` explanation doesn't cause the negative assertion to
   * flip. We only want to match JSX attribute usage.
   */
  function staleBannerJsx(): string {
    return staleBannerBody().replace(/\/\/[^\n]*/g, "");
  }

  it("uses role=\"status\" for the stale-data container", () => {
    expect(staleBannerJsx()).toMatch(/role="status"/);
  });

  it("does not use role=\"alert\" as a JSX prop (would preempt the screen reader)", () => {
    expect(staleBannerJsx()).not.toMatch(/role="alert"/);
  });

  it("declares aria-live=\"polite\" explicitly for AT compatibility", () => {
    // role="status" implies aria-live="polite" per ARIA, but naming
    // it explicitly is defensive in case any assistive tech doesn't
    // derive the live-region mapping from role alone.
    expect(staleBannerJsx()).toMatch(/aria-live="polite"/);
  });
});
