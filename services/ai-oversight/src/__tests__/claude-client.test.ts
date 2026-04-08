import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reviewPatientRecord,
  isLLMEnabled,
  assertLLMEnabled,
  LLMDisabledError,
} from "../services/claude-client.js";
import { SanitizationError } from "@carebridge/phi-sanitizer";

// Make sure the SDK is never actually called.
vi.mock("@anthropic-ai/sdk", () => {
  const create = vi.fn();
  class Anthropic {
    messages = { create };
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
    static BadRequestError = class extends Error {};
    static NotFoundError = class extends Error {};
    static RateLimitError = class extends Error {};
  }
  return { default: Anthropic, __create: create };
});

describe("reviewPatientRecord — fail-closed PHI guard", () => {
  it("throws SanitizationError before calling the API on unsanitized PHI", async () => {
    await expect(
      reviewPatientRecord("system", "Patient MRN: 123456789 reports fever"),
    ).rejects.toBeInstanceOf(SanitizationError);
  });
});

describe("LLM kill-switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("isLLMEnabled", () => {
    it("returns false when both env vars are unset", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "");
      expect(isLLMEnabled()).toBe(false);
    });

    it("returns false when only AI_OVERSIGHT_LLM_ENABLED is set", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "true");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "");
      expect(isLLMEnabled()).toBe(false);
    });

    it("returns false when only BAA_ACKNOWLEDGED is set", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "true");
      expect(isLLMEnabled()).toBe(false);
    });

    it("returns false when env values are 'false' literal string", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "false");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "false");
      expect(isLLMEnabled()).toBe(false);
    });

    it("returns false when env values are '1' instead of 'true'", () => {
      // Strict 'true' check — no truthy coercion
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "1");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "1");
      expect(isLLMEnabled()).toBe(false);
    });

    it("returns true only when both env vars are explicitly 'true'", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "true");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "true");
      expect(isLLMEnabled()).toBe(true);
    });
  });

  describe("assertLLMEnabled", () => {
    it("throws LLMDisabledError with LLM_ENABLED reason when flag is off", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "true");
      try {
        assertLLMEnabled();
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(LLMDisabledError);
        expect((e as LLMDisabledError).reason).toContain(
          "AI_OVERSIGHT_LLM_ENABLED",
        );
      }
    });

    it("throws LLMDisabledError with BAA reason when BAA flag is off", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "true");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "");
      try {
        assertLLMEnabled();
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(LLMDisabledError);
        expect((e as LLMDisabledError).reason).toContain(
          "AI_OVERSIGHT_BAA_ACKNOWLEDGED",
        );
      }
    });

    it("does not throw when both flags are 'true'", () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "true");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "true");
      expect(() => assertLLMEnabled()).not.toThrow();
    });
  });

  describe("reviewPatientRecord kill-switch defense", () => {
    it("throws LLMDisabledError on sanitized prompt when kill-switch engaged", async () => {
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "");
      // Use a fully sanitized prompt so SanitizationError is not the failure
      await expect(
        reviewPatientRecord("system", "Patient in [early 60s] with new symptom."),
      ).rejects.toBeInstanceOf(LLMDisabledError);
    });

    it("throws SanitizationError before kill-switch when PHI is present", async () => {
      // Sanitization runs first — even with kill-switch off, PHI is the primary
      // failure mode so callers know redaction failed.
      vi.stubEnv("AI_OVERSIGHT_LLM_ENABLED", "");
      vi.stubEnv("AI_OVERSIGHT_BAA_ACKNOWLEDGED", "");
      await expect(
        reviewPatientRecord("system", "MRN: 123456789"),
      ).rejects.toBeInstanceOf(SanitizationError);
    });
  });
});
