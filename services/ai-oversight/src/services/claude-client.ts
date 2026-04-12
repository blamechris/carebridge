/**
 * Claude API wrapper for clinical review.
 *
 * This module handles the actual LLM call with retry logic and timeouts.
 * It uses claude-sonnet-4-6 by default — fast enough for near-real-time review,
 * capable enough for clinical pattern recognition.
 */

import Anthropic from "@anthropic-ai/sdk";
import { assertPromptSanitized } from "@carebridge/phi-sanitizer";

/**
 * Allow-listed, non-PHI fields extracted from an error for structured logging.
 *
 * SECURITY: API error objects from the Anthropic SDK can carry request/response
 * fragments that include the original prompt — which in our case contains
 * patient clinical context. Never log the raw error, its `request`, `response`,
 * `body`, `messages`, `headers`, or `stack`. Only the fields below are safe.
 */
interface RedactedErrorInfo {
  name: string;
  status?: number;
  errorType?: string;
  code?: string;
  message: string;
}

/**
 * Exact-match allow list of short, generic error messages that by construction
 * contain no request/response content. Anything not on this list is replaced
 * with a category label so we never risk logging an SDK error whose `.message`
 * includes echoed prompt fragments (which for us would be patient context).
 *
 * The list is deliberately small and exact — adding loose patterns (e.g.
 * `/^rate limit.*$/`) would defeat the purpose because upstream services
 * commonly append request payload excerpts to otherwise-generic messages.
 */
const SAFE_MESSAGES: ReadonlySet<string> = new Set([
  "unauthorized",
  "forbidden",
  "not found",
  "rate limit exceeded",
  "rate limited",
  "request timed out",
  "network error",
  "bad request",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "connection refused",
  "connection reset",
]);

function sanitizeMessage(message: unknown): string {
  if (typeof message !== "string") return "<non-string message>";
  const trimmed = message.trim();
  if (trimmed.length === 0) return "<empty message>";
  if (SAFE_MESSAGES.has(trimmed.toLowerCase())) return trimmed;
  return "<redacted: non-allow-listed message>";
}

/**
 * Extract an allow-listed, PHI-free view of an error object suitable for
 * structured logging. No nested objects, no request/response bodies, no
 * headers, no stack traces.
 */
export function redactErrorForLog(error: unknown): RedactedErrorInfo {
  if (!error || typeof error !== "object") {
    return { name: "UnknownError", message: "<non-object error>" };
  }
  const err = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
    error?: unknown;
  };
  const info: RedactedErrorInfo = {
    name: typeof err.name === "string" ? err.name : "Error",
    message: sanitizeMessage(err.message),
  };
  if (typeof err.status === "number") info.status = err.status;
  if (typeof err.code === "string") info.code = err.code;
  // Anthropic SDK wraps API errors as { error: { type, message } }.
  // We only read the `type` tag (e.g. "rate_limit_error"), never the message,
  // because the API may echo fragments of the request in `error.message`.
  if (err.error && typeof err.error === "object") {
    const inner = err.error as { type?: unknown };
    if (typeof inner.type === "string") info.errorType = inner.type;
  }
  return info;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 15_000;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      // Uses ANTHROPIC_API_KEY environment variable by default
      timeout: REQUEST_TIMEOUT_MS,
    });
  }
  return client;
}

/**
 * Send a clinical review to Claude and return the text response.
 *
 * Retries up to 3 times with exponential backoff on transient failures.
 */
export async function reviewPatientRecord(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  // Fail-closed: refuse to transmit any prompt that hasn't been redacted.
  // Throws SanitizationError before any network call if residual PHI is found.
  assertPromptSanitized(userMessage);

  const anthropic = getClient();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      });

      // Extract text from the response
      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text content in Claude response");
      }

      return textBlock.text;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-transient errors. Wrap the original error in a
      // sanitized one — the SDK error's .message can echo back prompt
      // fragments / response bodies that contain PHI, and downstream
      // callers (e.g. review-service) log and persist `error.message`.
      // Per Copilot review on PR #374. Same shape as the exhausted-retries
      // throw below so all exit paths are PHI-safe.
      if (isNonTransientError(error)) {
        const redacted = redactErrorForLog(error);
        throw new Error(
          `Claude API call failed (non-transient): ${redacted.name}${
            redacted.status ? ` status=${redacted.status}` : ""
          }`,
        );
      }

      // Don't sleep after the last attempt
      if (attempt < MAX_RETRIES) {
        let delay: number;
        const redacted = redactErrorForLog(error);
        if (isRateLimitError(error)) {
          delay = getRetryAfterMs(error) ?? DEFAULT_RATE_LIMIT_DELAY_MS;
          console.log("[claude-client] rate_limited_retry", {
            attempt,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            error: redacted,
          });
        } else {
          delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log("[claude-client] transient_error_retry", {
            attempt,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            error: redacted,
          });
        }
        await sleep(delay);
      }
    }
  }

  const finalRedacted = lastError ? redactErrorForLog(lastError) : null;
  throw new Error(
    `Claude API call failed after ${MAX_RETRIES} attempts: ${
      finalRedacted
        ? `${finalRedacted.name}${finalRedacted.status ? ` status=${finalRedacted.status}` : ""}`
        : "unknown error"
    }`,
  );
}

function isNonTransientError(error: unknown): boolean {
  if (error instanceof Anthropic.AuthenticationError) return true;
  if (error instanceof Anthropic.PermissionDeniedError) return true;
  if (error instanceof Anthropic.BadRequestError) return true;
  if (error instanceof Anthropic.NotFoundError) return true;
  return false;
}

function isRateLimitError(error: unknown): boolean {
  if (
    typeof Anthropic.RateLimitError === "function" &&
    error instanceof Anthropic.RateLimitError
  ) {
    return true;
  }
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status?: number }).status === 429
  ) {
    return true;
  }
  return false;
}

function getRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { headers?: Record<string, string | string[] | undefined> })
    .headers;
  if (!headers) return null;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
