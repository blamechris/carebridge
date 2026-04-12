import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hold a reference to the mocked `create` so individual tests can program it.
const create = vi.fn();

// Mock the SDK. Error classes are plain stubs so `instanceof` checks in the
// client route the error into the right branch (non-transient vs transient).
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create };
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
    static BadRequestError = class extends Error {};
    static NotFoundError = class extends Error {};
    static RateLimitError = class extends Error {};
  }
  return { default: Anthropic };
});

// Import AFTER vi.mock so the mocked SDK is picked up.
const { reviewPatientRecord, redactErrorForLog } = await import(
  "../services/claude-client.js"
);

// A plausible PHI string that would appear in the original prompt. It must
// NOT match any of the sanitizer's PHI patterns (MRN/SSN/phone/date) or
// `assertPromptSanitized` would refuse the prompt before we ever got to the
// retry path we're trying to exercise. A free-text clinical name fits the
// bill — it reads like PHI but is not a regex-detectable identifier.
const PHI_NEEDLE = "Jane Q Doe stage-IV-pancreatic-adenocarcinoma";
const SAFE_PROMPT = `Review this clinical context: ${PHI_NEEDLE}`;

describe("claude-client error logging — PHI redaction", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    create.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Skip real retry backoff so tests don't hang on BASE_DELAY_MS timeouts.
    vi.useFakeTimers();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  function collectLogs(): string {
    const all = [...logSpy.mock.calls, ...errorSpy.mock.calls];
    // Flatten every call arg into a single string for a single contains check.
    return all
      .flat()
      .map((arg) =>
        typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg),
      )
      .join("\n");
  }

  it("redactErrorForLog never includes nested request/response or headers", () => {
    const sdkError: Record<string, unknown> = {
      name: "APIError",
      status: 500,
      message: `Server error echoing prompt: ${PHI_NEEDLE}`,
      request: {
        messages: [{ role: "user", content: PHI_NEEDLE }],
      },
      response: { body: PHI_NEEDLE },
      headers: { authorization: "Bearer sk-redact-me" },
      error: { type: "api_error", message: PHI_NEEDLE },
    };
    const redacted = redactErrorForLog(sdkError);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(PHI_NEEDLE);
    expect(serialized).not.toContain("sk-redact-me");
    // Must retain allow-listed identifying info.
    expect(redacted.status).toBe(500);
    expect(redacted.errorType).toBe("api_error");
    expect(redacted.name).toBe("APIError");
  });

  it("does NOT log PHI on a transient 5xx retry", async () => {
    // First two attempts fail with a PHI-laden transient error, third succeeds.
    const transientErr: Record<string, unknown> = {
      name: "APIConnectionError",
      status: 503,
      message: `upstream rejected body=${PHI_NEEDLE}`,
      request: {
        messages: [{ role: "user", content: PHI_NEEDLE }],
      },
      error: { type: "overloaded_error", message: PHI_NEEDLE },
    };
    create
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

    const pending = reviewPatientRecord("system", SAFE_PROMPT);
    // Drain the two backoff sleeps.
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toBe("ok");

    const joined = collectLogs();
    expect(joined).not.toContain(PHI_NEEDLE);
    // Structured log context we *do* expect to see.
    expect(joined).toContain("transient_error_retry");
    expect(joined).toContain("503");
  });

  it("does NOT log PHI on a rate-limit (429) retry", async () => {
    const rateErr: Record<string, unknown> = {
      name: "RateLimitError",
      status: 429,
      message: `rate limited while processing ${PHI_NEEDLE}`,
      headers: { "retry-after": "0" },
      request: {
        messages: [{ role: "user", content: PHI_NEEDLE }],
      },
      error: { type: "rate_limit_error", message: PHI_NEEDLE },
    };
    create
      .mockRejectedValueOnce(rateErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
      });

    const pending = reviewPatientRecord("system", SAFE_PROMPT);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toBe("ok");

    const joined = collectLogs();
    expect(joined).not.toContain(PHI_NEEDLE);
    expect(joined).toContain("rate_limited_retry");
    expect(joined).toContain("429");
  });

  it("does NOT leak PHI in the final thrown error message after exhausting retries", async () => {
    const transientErr: Record<string, unknown> = {
      name: "APIConnectionError",
      status: 502,
      message: `bad gateway echoing ${PHI_NEEDLE}`,
      request: { messages: [{ role: "user", content: PHI_NEEDLE }] },
    };
    create.mockRejectedValue(transientErr);

    const pending = reviewPatientRecord("system", SAFE_PROMPT);
    const assertion = expect(pending).rejects.toThrow(/Claude API call failed/);
    await vi.runAllTimersAsync();
    await assertion;

    // Also assert the thrown error's message directly.
    create.mockRejectedValue(transientErr);
    let thrown: unknown;
    const p = reviewPatientRecord("system", SAFE_PROMPT).catch((e) => {
      thrown = e;
    });
    await vi.runAllTimersAsync();
    await p;
    expect(String((thrown as Error).message)).not.toContain(PHI_NEEDLE);

    const joined = collectLogs();
    expect(joined).not.toContain(PHI_NEEDLE);
  });
});
