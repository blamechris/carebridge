/**
 * Issue #404 — static regression guard for the clinician-portal
 * responsive layout.
 *
 * jsdom cannot evaluate `@media (max-width: ...)` against a styled
 * element at a simulated viewport width; Next.js compiles globals.css
 * to a stylesheet that only applies in a real browser. Instead of a
 * visual-render test (which requires Playwright) we verify that
 * globals.css contains the specific rules the issue's acceptance
 * criteria depend on:
 *
 *   1. A 1024px tablet breakpoint that displays `.sidebar-toggle`
 *      and translates the sidebar off-screen.
 *   2. A 767px phone breakpoint that stacks tables and enforces the
 *      44px touch target minimum on `.btn`.
 *   3. Body-level `overflow-x: hidden` to prevent accidental
 *      horizontal scroll.
 *   4. A `.table-container` that allows horizontal scroll (fallback
 *      for tables without `data-label` support on narrow viewports).
 *
 * These are cheap invariants that prevent someone from deleting the
 * media queries during a future refactor and silently regressing the
 * mobile layout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = resolve(__dirname, "../../app/globals.css");
const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

/** Extract the body of the first `@media (<query>) { ... }` block. */
function mediaBlock(query: string): string {
  // Escape the query for the regex.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `@media\\s*\\(\\s*${escaped}\\s*\\)\\s*\\{`,
    "i",
  );
  const match = css.match(pattern);
  if (!match || match.index === undefined) return "";
  // Naive brace-matcher: start from the opening brace and walk.
  let depth = 0;
  let i = match.index + match[0].length - 1; // points at `{`
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return css.slice(match.index + match[0].length, i);
      }
    }
  }
  return "";
}

describe("clinician-portal responsive breakpoints (Issue #404)", () => {
  it("declares a 1023px (tablet) breakpoint", () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*1023px\s*\)/);
  });

  it("declares a 767px (phone) breakpoint", () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*767px\s*\)/);
  });

  it("shows the sidebar toggle and slides sidebar off at <1024px", () => {
    const tablet = mediaBlock("max-width: 1023px");
    expect(tablet).toMatch(/\.sidebar-toggle\s*\{[^}]*display:\s*flex/);
    expect(tablet).toMatch(/\.sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);
    expect(tablet).toMatch(/\.sidebar\.sidebar-open\s*\{[^}]*transform:\s*translateX\(0\)/);
  });

  it("stacks tables and enforces a 44px touch target floor at <768px", () => {
    const phone = mediaBlock("max-width: 767px");
    // Tables become cards: <tr> is block, <thead> is offscreen.
    expect(phone).toMatch(/thead\s*\{[^}]*position:\s*absolute/);
    expect(phone).toMatch(/td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    // Primary button meets WCAG 2.5.5 minimum (44×44).
    expect(phone).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/);
    expect(phone).toMatch(/\.btn\s*\{[^}]*min-width:\s*44px/);
  });

  it("sets body overflow-x: hidden to prevent page-level horizontal scroll", () => {
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
  });

  it("gives .table-container a horizontal-scroll fallback", () => {
    expect(css).toMatch(/\.table-container\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("keeps the sidebar-toggle's hamburger icon at 44×44 (touch-target)", () => {
    // The icon hit-area in the toggle button.
    expect(css).toMatch(
      /\.sidebar-toggle-icon\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s,
    );
  });
});
