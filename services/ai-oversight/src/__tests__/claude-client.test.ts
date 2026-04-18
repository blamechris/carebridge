import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hold a reference to the mocked `create` so individual tests can program it.
const create = vi.fn();

// Mock the SDK before any imports that use it.
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create };
    static AuthenticationError = class extends Error {
      name = "AuthenticationError";
    };
    static PermissionDeniedError = class extends Error {
      name = "PermissionDeniedError";
    };
    static BadRequestError = class extends Error {
      name = "BadRequestError";
    };
    static NotFoundError = class extends Error {
      name = "NotFoundError";
    };
    static RateLimitError = class extends Error {
      name = "RateLimitError";
    };
  }
  return { default: Anthropic };
});

// Import AFTER vi.mock so the mocked SDK is picked up.
const { reviewPatientRecord, redactErrorForLog } = await import(
  "../services/claude-client.js"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;

// A prompt that passes PHI sanitization (no MRN/SSN/phone/date patterns).
const SAFE_SYSTEM = "You are a clinical reviewer.";
const SAFE_PROMPT = "Review this clinical context: elevated troponin trend noted.";

describe("reviewPatientRecord — successful API response", () => {
  beforeEach(() => {
    create.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns text from a valid API response with a single text block", async () => {
    create.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '{"flags":[],"summary":"No concerns identified."}',
        },
      ],
    });

    const result = await reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    expect(result).toBe('{"flags":[],"summary":"No concerns identified."}');
  });

  it("extracts the first text block when response contains multiple blocks", async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: "text", text: "first block" },
        { type: "text", text: "second block" },
      ],
    });

    const result = await reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    expect(result).toBe("first block");
  });

  it("throws when response has no text blocks (after exhausting retries)", async () => {
    // "No text content" is not a non-transient SDK error, so the client
    // retries it 3 times before giving up.
    create.mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
    });

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrow(/Claude API call failed after 3 attempts/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("throws when response content is empty (after exhausting retries)", async () => {
    create.mockResolvedValue({ content: [] });

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrow(/Claude API call failed after 3 attempts/);
  });
});

describe("reviewPatientRecord — PHI sanitization guard", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("throws SanitizationError before calling the API on unsanitized PHI", async () => {
    const { SanitizationError } = await import("@carebridge/phi-sanitizer");

    await expect(
      reviewPatientRecord(SAFE_SYSTEM, "Patient MRN: 123456789 reports fever"),
    ).rejects.toBeInstanceOf(SanitizationError);

    // API must never be called.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("reviewPatientRecord — timeout and network errors", () => {
  beforeEach(() => {
    create.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on transient network error and succeeds on third attempt", async () => {
    const networkErr = new Error("network error");
    create
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "recovered" }],
      });

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("recovered");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all retries on persistent timeout", async () => {
    const timeoutErr = new Error("request timed out");
    create.mockRejectedValue(timeoutErr);

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrow(
      /Claude API call failed after 3 attempts/,
    );
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-transient AuthenticationError", async () => {
    const authErr = new Anthropic.AuthenticationError(401, undefined, "unauthorized", undefined as any);
    create.mockRejectedValueOnce(authErr);

    await expect(
      reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT),
    ).rejects.toThrow(/non-transient/);

    // Only one attempt — no retries for authentication errors.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-transient BadRequestError", async () => {
    const badReq = new Anthropic.BadRequestError(400, undefined, "bad request", undefined as any);
    create.mockRejectedValueOnce(badReq);

    await expect(
      reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT),
    ).rejects.toThrow(/non-transient/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("reviewPatientRecord — rate limit (429) handling", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    create.mockReset();
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("respects Retry-After header on 429 and succeeds on second attempt", async () => {
    const rateLimitErr: Record<string, unknown> = {
      name: "RateLimitError",
      status: 429,
      message: "rate limit exceeded",
      headers: { "retry-after": "2" },
    };
    create
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "after rate limit" }],
      });

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("after rate limit");
    expect(create).toHaveBeenCalledTimes(2);

    // Verify the rate-limit retry path was taken.
    const logCalls = logSpy.mock.calls.map((c) => JSON.stringify(c));
    const hasRateLimitLog = logCalls.some((s) =>
      s.includes("rate_limited_retry"),
    );
    expect(hasRateLimitLog).toBe(true);
  });

  it("uses default delay when Retry-After header is missing", async () => {
    const rateLimitErr: Record<string, unknown> = {
      name: "RateLimitError",
      status: 429,
      message: "rate limited",
    };
    create
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

    const pending = reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toBe("ok");
  });
});

describe("reviewPatientRecord — malformed response handling", () => {
  beforeEach(() => {
    create.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns raw text even when response text is not valid JSON", async () => {
    // The claude-client returns the raw text string; JSON parsing is the
    // caller's responsibility. Verify it passes through malformed JSON.
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: "{malformed json: ???}" }],
    });

    const result = await reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    expect(result).toBe("{malformed json: ???}");
  });

  it("returns empty string text from API without error", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: "" }],
    });

    const result = await reviewPatientRecord(SAFE_SYSTEM, SAFE_PROMPT);
    expect(result).toBe("");
  });
});

describe("redactErrorForLog", () => {
  it("returns generic info for non-object error", () => {
    const info = redactErrorForLog(null);
    expect(info.name).toBe("UnknownError");
    expect(info.message).toBe("<non-object error>");
  });

  it("returns generic info for undefined error", () => {
    const info = redactErrorForLog(undefined);
    expect(info.name).toBe("UnknownError");
  });

  it("redacts non-allow-listed message strings", () => {
    const info = redactErrorForLog({
      name: "APIError",
      message: "something with patient data Jane Doe MRN 12345",
    });
    expect(info.message).toBe("<redacted: non-allow-listed message>");
    expect(info.name).toBe("APIError");
  });

  it("preserves allow-listed safe messages", () => {
    const info = redactErrorForLog({
      name: "Error",
      message: "rate limit exceeded",
    });
    expect(info.message).toBe("rate limit exceeded");
  });

  it("preserves allow-listed messages case-insensitively", () => {
    const info = redactErrorForLog({
      name: "Error",
      message: "Network Error",
    });
    expect(info.message).toBe("Network Error");
  });

  it("captures status code and error type", () => {
    const info = redactErrorForLog({
      name: "RateLimitError",
      status: 429,
      error: { type: "rate_limit_error" },
    });
    expect(info.status).toBe(429);
    expect(info.errorType).toBe("rate_limit_error");
  });

  it("does not capture request, response, headers, or stack", () => {
    const info = redactErrorForLog({
      name: "Error",
      message: "network error",
      status: 500,
      request: { body: "secret" },
      response: { data: "phi" },
      headers: { authorization: "Bearer sk-xxx" },
      stack: "Error at line 42",
    });
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("phi");
    expect(serialized).not.toContain("sk-xxx");
    expect(serialized).not.toContain("line 42");
  });

  it("handles non-string name gracefully", () => {
    const info = redactErrorForLog({ name: 42, message: "forbidden" });
    expect(info.name).toBe("Error");
  });

  it("handles non-string message gracefully", () => {
    const info = redactErrorForLog({ name: "Error", message: 123 });
    expect(info.message).toBe("<non-string message>");
  });

  it("handles empty message", () => {
    const info = redactErrorForLog({ name: "Error", message: "   " });
    expect(info.message).toBe("<empty message>");
  });
});
