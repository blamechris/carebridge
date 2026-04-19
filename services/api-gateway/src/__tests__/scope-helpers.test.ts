/**
 * Unit tests for the pure scope helpers exported from @carebridge/shared-types.
 * The router-level matrix test (caregiver-scope-matrix.test.ts) covers the
 * integration; this file locks in the tiny algebra so the superset rules
 * can't regress silently.
 */

import { describe, it, expect } from "vitest";
import {
  hasScope,
  normaliseScopes,
  SCOPE_TOKENS,
  DEFAULT_CAREGIVER_SCOPES,
  type ScopeToken,
} from "@carebridge/shared-types";

describe("hasScope", () => {
  it("grants the exact requested token", () => {
    for (const token of SCOPE_TOKENS) {
      expect(hasScope([token], token)).toBe(true);
    }
  });

  it("view_and_message grants every token as a superset", () => {
    for (const token of SCOPE_TOKENS) {
      expect(hasScope(["view_and_message"], token)).toBe(true);
    }
  });

  it("read_only is equivalent to view_summary", () => {
    expect(hasScope(["read_only"], "view_summary")).toBe(true);
    expect(hasScope(["view_summary"], "read_only")).toBe(true);
  });

  it("read_only does NOT grant labs / medications / notes / appointments", () => {
    const nonSummary: ScopeToken[] = [
      "view_labs",
      "view_medications",
      "view_notes",
      "view_appointments",
    ];
    for (const token of nonSummary) {
      expect(hasScope(["read_only"], token)).toBe(false);
    }
  });

  it("denies when scope not present", () => {
    expect(hasScope(["view_summary"], "view_labs")).toBe(false);
    expect(hasScope(["view_medications"], "view_notes")).toBe(false);
  });

  it("null or empty scope set applies the default (read_only)", () => {
    // read_only alone permits view_summary, denies everything else — assert
    // both ends of that so "default = all scopes" can't slip in by mistake.
    expect(hasScope(null, "view_summary")).toBe(true);
    expect(hasScope(undefined, "read_only")).toBe(true);
    expect(hasScope([], "view_summary")).toBe(true);
    expect(hasScope(null, "view_labs")).toBe(false);
    expect(hasScope(undefined, "view_and_message")).toBe(false);
  });

  it("multiple scopes combine additively", () => {
    const scopes: ScopeToken[] = ["view_labs", "view_medications"];
    expect(hasScope(scopes, "view_labs")).toBe(true);
    expect(hasScope(scopes, "view_medications")).toBe(true);
    expect(hasScope(scopes, "view_notes")).toBe(false);
  });
});

describe("normaliseScopes", () => {
  it("returns the default when input is null or undefined", () => {
    expect(normaliseScopes(null)).toEqual(DEFAULT_CAREGIVER_SCOPES);
    expect(normaliseScopes(undefined)).toEqual(DEFAULT_CAREGIVER_SCOPES);
  });

  it("returns the default for an empty array", () => {
    expect(normaliseScopes([])).toEqual(DEFAULT_CAREGIVER_SCOPES);
  });

  it("returns the input when non-empty", () => {
    const scopes: ScopeToken[] = ["view_labs"];
    expect(normaliseScopes(scopes)).toBe(scopes);
  });
});
