/**
 * LLM Interaction Audit Trail
 *
 * Every call to an external LLM with patient context must be audited.
 * This module provides the audit record structure and logging utilities.
 *
 * Audit records capture:
 *   - Which patient's data was involved (internal ID only — no PHI)
 *   - What fields were redacted before transmission
 *   - The model and prompt version used
 *   - Whether the response was valid or failed validation
 *   - Token counts for cost/privacy analysis
 *   - A hash of the sanitized prompt (not the original) for dedup
 */

import crypto from "node:crypto";

export interface LLMInteractionAudit {
  interaction_id: string;
  patient_id: string;
  timestamp: string;
  model: string;
  prompt_version: string;
  fields_redacted: string[];
  provider_count_redacted: number;
  prompt_hash: string; // SHA-256 of sanitized prompt — not the original
  request_tokens: number | null;
  response_tokens: number | null;
  response_valid: boolean;
  response_flags_count: number;
  validation_error: string | null;
  latency_ms: number;
}

/**
 * Create a SHA-256 hash of the sanitized prompt.
 * This allows deduplication checks without storing any PHI.
 */
export function hashPrompt(sanitizedPrompt: string): string {
  return crypto.createHash("sha256").update(sanitizedPrompt, "utf8").digest("hex");
}

/**
 * Build an LLM interaction audit record.
 */
export function buildLLMAudit(params: {
  patientId: string;
  model: string;
  promptVersion: string;
  fieldsRedacted: string[];
  providerCountRedacted: number;
  sanitizedPrompt: string;
  requestTokens: number | null;
  responseTokens: number | null;
  responseValid: boolean;
  responseFlagsCount: number;
  validationError: string | null;
  latencyMs: number;
}): LLMInteractionAudit {
  return {
    interaction_id: crypto.randomUUID(),
    patient_id: params.patientId,
    timestamp: new Date().toISOString(),
    model: params.model,
    prompt_version: params.promptVersion,
    fields_redacted: params.fieldsRedacted,
    provider_count_redacted: params.providerCountRedacted,
    prompt_hash: hashPrompt(params.sanitizedPrompt),
    request_tokens: params.requestTokens,
    response_tokens: params.responseTokens,
    response_valid: params.responseValid,
    response_flags_count: params.responseFlagsCount,
    validation_error: params.validationError,
    latency_ms: params.latencyMs,
  };
}
