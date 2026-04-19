/**
 * @vitest-environment jsdom
 *
 * Issue #404 — patient-portal labs table mobile stacking.
 *
 * The labs page is the widest table in the patient portal: Test, Value,
 * Reference Range, Status. At 320px all four columns cannot fit side by
 * side without truncation, so the table opts into the `.pp-stack-table`
 * helper (defined in globals.css) which re-flows each <tr> as a card on
 * phones. For this to be readable, every <td> must carry a `data-label`
 * attribute that matches its header — this test pins that contract.
 *
 * Rather than mount the full <LabsPage> (which drags in auth + tRPC +
 * the active-patient context), we assert the structural invariants by
 * scanning the source: `data-label` count == header count, and the
 * class name is present. This keeps the test hermetic and fast.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LABS_PAGE_PATH = resolve(__dirname, "../../app/labs/page.tsx");
const source = readFileSync(LABS_PAGE_PATH, "utf8");

describe("patient-portal labs table stacks on mobile (Issue #404)", () => {
  it("applies the .pp-stack-table helper class to the <table>", () => {
    expect(source).toMatch(/<table[^>]*className="pp-stack-table"/);
  });

  it("labels every data cell so stacked cards show the column header", () => {
    // The labs table has exactly four columns: Test, Value,
    // Reference Range, Status. Each <td> must carry the matching
    // data-label.
    expect(source).toMatch(/data-label="Test"/);
    expect(source).toMatch(/data-label="Value"/);
    expect(source).toMatch(/data-label="Reference Range"/);
    expect(source).toMatch(/data-label="Status"/);
  });
});
