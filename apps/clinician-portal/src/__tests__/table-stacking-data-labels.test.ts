/**
 * Issue #404 — clinician-portal table stacking relies on `data-label`
 * attributes on every <td>.
 *
 * globals.css renders `td::before { content: attr(data-label) }` on
 * phones to supply the column header for each stacked card cell. If a
 * page ships a <td> without `data-label` the cell will be anonymous
 * on mobile ("— : 42.3 mmol/L" instead of "Value: 42.3 mmol/L"),
 * which makes labs tables unreadable on a phone.
 *
 * Rather than render every page (heavy tRPC + auth mocking) we scan
 * the source for the key tables we care about and count <td> vs
 * `data-label` occurrences. A helper below ignores <td> that only
 * carry `colSpan` (loading / empty-state placeholder rows).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function countLabeledCells(source: string): { td: number; labeled: number } {
  // Strip <td> tags that are followed immediately (same opening tag)
  // by colSpan — those are the loading / empty placeholders.
  const tds = source.match(/<td\b[^>]*>/g) ?? [];
  let td = 0;
  let labeled = 0;
  for (const tag of tds) {
    if (/colSpan\s*=/.test(tag)) continue;
    td++;
    if (/data-label\s*=/.test(tag)) labeled++;
  }
  return { td, labeled };
}

const cases: Array<{ label: string; path: string; min: number }> = [
  {
    label: "patients list",
    path: "../../app/patients/page.tsx",
    min: 5,
  },
  {
    label: "dashboard recent patients",
    path: "../../app/page.tsx",
    min: 4,
  },
  {
    label: "notes list",
    path: "../../app/notes/page.tsx",
    min: 6,
  },
  {
    label: "patient detail (labs + medications)",
    path: "../../app/patients/[id]/page.tsx",
    min: 10, // 5 labs cols + 5 meds cols
  },
];

describe("clinician-portal tables have data-label on every <td> (Issue #404)", () => {
  for (const c of cases) {
    it(`${c.label}: every real <td> carries a data-label`, () => {
      const source = readFileSync(resolve(__dirname, c.path), "utf8");
      const { td, labeled } = countLabeledCells(source);
      expect(td).toBeGreaterThanOrEqual(c.min);
      expect(labeled).toBe(td);
    });
  }
});
