/**
 * LLM Interaction Audit Table
 *
 * Every call to an external LLM that involves patient context must be
 * recorded here. This supports:
 *   - HIPAA audit trail for PHI disclosures to third-party services
 *   - Token usage monitoring for cost control
 *   - Prompt injection detection (via prompt_hash comparison)
 *   - Model governance (tracks which model version generated each review)
 *   - De-identification verification (fields_redacted documents what was stripped)
 */

import { pgTable, text, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

export const llmInteractionLog = pgTable("llm_interaction_log", {
  id: text("id").primaryKey(),

  // Which patient's data was involved (internal ID only — no PHI stored here)
  patient_id: text("patient_id").notNull().references(() => patients.id),

  // Which review job triggered this LLM call
  review_job_id: text("review_job_id"),

  // LLM configuration
  model: text("model").notNull(),
  prompt_version: text("prompt_version").notNull(),

  // De-identification audit: what was stripped before transmission
  fields_redacted: jsonb("fields_redacted").$type<string[]>().default([]),
  provider_count_redacted: integer("provider_count_redacted").notNull().default(0),

  // SHA-256 hash of the sanitized prompt — allows dedup without storing PHI
  prompt_hash: text("prompt_hash"),

  // Token usage (for cost and privacy analysis)
  request_tokens: integer("request_tokens"),
  response_tokens: integer("response_tokens"),

  // Response quality
  response_valid: boolean("response_valid").notNull().default(false),
  response_flags_count: integer("response_flags_count").notNull().default(0),
  validation_error: text("validation_error"),

  // Performance
  latency_ms: integer("latency_ms"),

  timestamp: text("timestamp").notNull(),
}, (table) => [
  index("idx_llm_audit_patient").on(table.patient_id, table.timestamp),
  index("idx_llm_audit_model").on(table.model, table.timestamp),
  index("idx_llm_audit_hash").on(table.prompt_hash),
]);
