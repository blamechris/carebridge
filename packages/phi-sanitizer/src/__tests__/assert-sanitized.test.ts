import { describe, it, expect } from "vitest";
import { assertPromptSanitized, SanitizationError } from "../redactor.js";

describe("assertPromptSanitized — fail-closed PHI guard", () => {
  it("passes for a fully redacted prompt", () => {
    const text = "Patient is in [early 60s], diagnosed [3 days ago] by [PROVIDER-1].";
    expect(() => assertPromptSanitized(text)).not.toThrow();
  });

  it("throws on a labeled MRN", () => {
    expect(() => assertPromptSanitized("MRN: 123456789 has fever")).toThrow(
      SanitizationError,
    );
  });

  it("throws on an ISO date", () => {
    expect(() => assertPromptSanitized("Visit on 2026-04-07")).toThrow(
      SanitizationError,
    );
  });

  it("throws on a US phone number", () => {
    expect(() => assertPromptSanitized("Call (555) 123-4567")).toThrow(
      SanitizationError,
    );
  });

  it("throws on an SSN-like pattern", () => {
    expect(() => assertPromptSanitized("SSN 123-45-6789")).toThrow(
      SanitizationError,
    );
  });

  it("error includes which pattern matched (no PHI in message)", () => {
    try {
      assertPromptSanitized("MRN: 123456789");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SanitizationError);
      expect((e as SanitizationError).message).not.toContain("123456789");
      expect((e as SanitizationError).violations.length).toBeGreaterThan(0);
    }
  });
});
