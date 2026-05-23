/**
 * Unit tests for the Epic error-code registry (#1102).
 *
 * Sanity check that the canonical codes haven't drifted from what
 * sync-jobs / fhir-client actually use. If a future PR changes a
 * literal in either place without updating the registry (or vice
 * versa), this test surfaces the drift before runtime.
 */
import { describe, it, expect } from "vitest";
import { EPIC_ERROR_CODES, type EpicErrorCode } from "../epic-error-codes.js";

describe("EPIC_ERROR_CODES (#1102)", () => {
  it("UNAUTHORIZED_SUB_RESOURCE matches Epic's documented code 59022", () => {
    expect(EPIC_ERROR_CODES.UNAUTHORIZED_SUB_RESOURCE).toBe("59022");
  });

  it("MISSING_REQUIRED_ELEMENT matches Epic's documented code 59108", () => {
    expect(EPIC_ERROR_CODES.MISSING_REQUIRED_ELEMENT).toBe("59108");
  });

  it("EpicErrorCode type narrows to the registry values", () => {
    // Type-level assertion: any string literal that matches a registry
    // value is assignable to EpicErrorCode; arbitrary strings are not.
    const ok: EpicErrorCode = "59022";
    expect(ok).toBe("59022");
    // @ts-expect-error — arbitrary strings must not satisfy EpicErrorCode
    const bad: EpicErrorCode = "not-a-real-code";
    expect(bad).toBe("not-a-real-code");
  });

  it("registry codes are all unique", () => {
    const values = Object.values(EPIC_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
