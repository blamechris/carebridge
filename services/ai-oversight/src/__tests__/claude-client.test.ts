import { describe, it, expect, vi } from "vitest";
import { reviewPatientRecord } from "../services/claude-client.js";
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
