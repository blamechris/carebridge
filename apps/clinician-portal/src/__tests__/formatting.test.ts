import { describe, it, expect } from "vitest";
import {
  RANGE_SEPARATOR,
  NO_VALUE,
  formatReferenceRange,
} from "../lib/formatting.js";

describe("formatting constants", () => {
  it("RANGE_SEPARATOR is an en-dash", () => {
    expect(RANGE_SEPARATOR).toBe("\u2013");
  });

  it("NO_VALUE is an em-dash", () => {
    expect(NO_VALUE).toBe("\u2014");
  });
});

describe("formatReferenceRange", () => {
  it("returns low\u2013high when both bounds are present", () => {
    expect(formatReferenceRange(3.5, 5.0)).toBe("3.5\u20135");
  });

  it("returns '> low' when only low bound is present", () => {
    expect(formatReferenceRange(3.5, null)).toBe("> 3.5");
    expect(formatReferenceRange(3.5, undefined)).toBe("> 3.5");
  });

  it("returns '< high' when only high bound is present", () => {
    expect(formatReferenceRange(null, 5.0)).toBe("< 5");
    expect(formatReferenceRange(undefined, 5.0)).toBe("< 5");
  });

  it("returns em-dash when neither bound is present", () => {
    expect(formatReferenceRange(null, null)).toBe("\u2014");
    expect(formatReferenceRange(undefined, undefined)).toBe("\u2014");
    expect(formatReferenceRange()).toBe("\u2014");
  });

  it("treats 0 as a valid numeric bound", () => {
    expect(formatReferenceRange(0, 10)).toBe("0\u201310");
    expect(formatReferenceRange(0, null)).toBe("> 0");
    expect(formatReferenceRange(null, 0)).toBe("< 0");
  });
});
