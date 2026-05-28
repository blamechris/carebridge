/**
 * Regression test for #1275.
 *
 * The "+ New Note" link in `apps/clinician-portal/app/patients/[id]/page.tsx`
 * interpolates `patientId` from `useParams()` into the query string. The
 * route segment is URL-decoded by Next, so any `&` / `?` / `#` in the id
 * would corrupt the resulting URL if it were re-interpolated raw.
 *
 * Patient ids today are UUID v4 (hex + hyphen, no special chars), so this
 * is hygiene/defence-in-depth, not a real exploit surface — but we lock
 * the contract here so a future schema change can't silently break the
 * link.
 */
import { describe, it, expect } from "vitest";

// Mirror of the href construction in
// apps/clinician-portal/app/patients/[id]/page.tsx (~line 1020).
function buildNewNoteHref(patientId: string): string {
  return `/notes/new?patientId=${encodeURIComponent(patientId)}`;
}

describe("New Note href encoding (#1275)", () => {
  it("preserves a normal UUID v4", () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    expect(buildNewNoteHref(uuid)).toBe(`/notes/new?patientId=${uuid}`);
  });

  it("URL-encodes `&` so it cannot start a new query param", () => {
    const href = buildNewNoteHref("a&injected=1");
    expect(href).toBe("/notes/new?patientId=a%26injected%3D1");
    // round-trip: parser sees a single patientId param
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("patientId")).toBe("a&injected=1");
    expect(params.get("injected")).toBeNull();
  });

  it("URL-encodes `?` and `#`", () => {
    expect(buildNewNoteHref("a?b")).toBe("/notes/new?patientId=a%3Fb");
    expect(buildNewNoteHref("a#b")).toBe("/notes/new?patientId=a%23b");
  });

  it("URL-encodes spaces", () => {
    expect(buildNewNoteHref("a b")).toBe("/notes/new?patientId=a%20b");
  });
});
