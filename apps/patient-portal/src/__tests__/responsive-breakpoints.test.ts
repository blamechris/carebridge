/**
 * Issue #404 — patient-portal responsive breakpoints.
 *
 * The patient portal's globals.css historically contained no media
 * queries at all (Issue #404 audit). The rules this test pins:
 *
 *   1. A <1024px rule that shrinks body padding (so the 2rem inline
 *      padding doesn't crowd the 320px iPhone viewport).
 *   2. A <768px rule that enforces a 44×44 touch-target floor on
 *      every <button>, <a role="button">, and text-like input.
 *   3. A `.pp-stack-table` opt-in helper that re-flows a table as
 *      stacked cards on phones, using `data-label` attributes for
 *      column headers.
 *   4. Page-level `overflow-x: hidden` to prevent horizontal scroll
 *      at 320px.
 *
 * Like the clinician-portal sibling test, these are static-file
 * invariants: jsdom can't evaluate media queries, so we assert the
 * source contains the rules. A render-based counterpart for the
 * labs table (which uses `.pp-stack-table`) lives in
 * `labs-stack-table.test.tsx`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS_PATH = resolve(__dirname, "../../app/globals.css");
const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

function mediaBlock(query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `@media\\s*\\(\\s*${escaped}\\s*\\)\\s*\\{`,
    "i",
  );
  const match = css.match(pattern);
  if (!match || match.index === undefined) return "";
  let depth = 0;
  let i = match.index + match[0].length - 1;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(match.index + match[0].length, i);
    }
  }
  return "";
}

describe("patient-portal responsive breakpoints (Issue #404)", () => {
  it("declares a 1023px (tablet) breakpoint that shrinks body padding", () => {
    const tablet = mediaBlock("max-width: 1023px");
    expect(tablet).toMatch(/body\s*\{[^}]*padding:\s*1rem/);
  });

  it("declares a 767px (phone) breakpoint", () => {
    expect(css).toMatch(/@media\s*\(\s*max-width:\s*767px\s*\)/);
  });

  it("enforces 44×44 touch targets on interactive elements at <768px", () => {
    const phone = mediaBlock("max-width: 767px");
    // Match any rule block that includes both button and min-height: 44px.
    // The grouped selector contains button, input[type=submit], etc.
    expect(phone).toMatch(/button[\s\S]{0,400}min-height:\s*44px/);
    expect(phone).toMatch(/button[\s\S]{0,400}min-width:\s*44px/);
    // Text inputs also get the floor.
    expect(phone).toMatch(/input\[type="text"\][\s\S]{0,400}min-height:\s*44px/);
  });

  it("provides the .pp-stack-table helper with data-label support", () => {
    const phone = mediaBlock("max-width: 767px");
    expect(phone).toMatch(/table\.pp-stack-table[\s\S]*?thead\s*\{[^}]*position:\s*absolute/);
    expect(phone).toMatch(
      /table\.pp-stack-table\s+td::before\s*\{[^}]*content:\s*attr\(data-label\)/,
    );
  });

  it("sets page-level overflow-x: hidden", () => {
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
  });
});
