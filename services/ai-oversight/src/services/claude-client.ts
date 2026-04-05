/**
 * Claude API wrapper for clinical review.
 *
 * This module handles the actual LLM call with retry logic and timeouts.
 * It uses claude-sonnet-4-6 by default — fast enough for near-real-time review,
 * capable enough for clinical pattern recognition.
 */

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

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

export interface ReviewResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Send a clinical review to Claude and return the response with token usage.
 *
 * Retries up to 3 times with exponential backoff on transient failures.
 *
 * IMPORTANT: The caller must ensure the userMessage has been sanitized
 * (PHI redacted) before calling this function. This module does NOT
 * perform redaction — see packages/phi-sanitizer.
 */
export async function reviewPatientRecord(
  systemPrompt: string,
  userMessage: string,
): Promise<ReviewResponse> {
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

      return {
        text: textBlock.text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-transient errors
      if (isNonTransientError(error)) {
        throw lastError;
      }

      // Don't sleep after the last attempt
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
          `[claude-client] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${lastError.message}`,
        );
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
