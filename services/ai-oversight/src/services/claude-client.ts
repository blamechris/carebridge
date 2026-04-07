/**
 * Claude API wrapper for clinical review.
 *
 * This module handles the actual LLM call with retry logic and timeouts.
 * It uses claude-sonnet-4-6 by default — fast enough for near-real-time review,
 * capable enough for clinical pattern recognition.
 */

import Anthropic from "@anthropic-ai/sdk";
import { assertPromptSanitized } from "@carebridge/phi-sanitizer";

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

      // Don't retry on non-transient errors
      if (isNonTransientError(error)) {
        throw lastError;
      }

      // Don't sleep after the last attempt
      if (attempt < MAX_RETRIES) {
        let delay: number;
        if (isRateLimitError(error)) {
          delay = getRetryAfterMs(error) ?? DEFAULT_RATE_LIMIT_DELAY_MS;
          console.log(
            `[claude-client] Rate-limited (429) on attempt ${attempt}/${MAX_RETRIES}, respecting Retry-After, waiting ${delay}ms: ${lastError.message}`,
          );
        } else {
          delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(
            `[claude-client] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${lastError.message}`,
          );
        }
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Claude API call failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
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
