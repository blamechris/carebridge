import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

export const clinicalFlags = pgTable("clinical_flags", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  source: text("source").notNull(), // rules, ai-review
  rule_id: text("rule_id"),
  severity: text("severity").notNull(), // critical, warning, info
  confidence: integer("confidence"), // 0-100, LLM-only
  requires_human_review: boolean("requires_human_review").notNull().default(true),
  category: text("category").notNull(), // cross-specialty, drug-interaction, etc.
  summary: text("summary").notNull(),
  rationale: text("rationale").notNull(),
  suggested_action: text("suggested_action").notNull(),
  notify_specialties: jsonb("notify_specialties").$type<string[]>().default([]),
  trigger_event_ids: jsonb("trigger_event_ids").$type<string[]>().default([]),
  status: text("status").notNull().default("open"),
  resolution_note: text("resolution_note"),
  acknowledged_by: text("acknowledged_by"),
  acknowledged_at: text("acknowledged_at"),
  resolved_by: text("resolved_by"),
  resolved_at: text("resolved_at"),
  dismissed_by: text("dismissed_by"),
  dismissed_at: text("dismissed_at"),
  dismiss_reason: text("dismiss_reason"),
  model_id: text("model_id"),
  prompt_version: text("prompt_version"),
  escalation_count: integer("escalation_count").notNull().default(0),
  last_escalated_at: text("last_escalated_at"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_flags_patient").on(table.patient_id, table.status),
  index("idx_flags_severity").on(table.severity, table.status),
  index("idx_flags_escalation_scan").on(
    table.severity,
    table.status,
    table.acknowledged_at,
    table.escalation_count,
  ),
  uniqueIndex("idx_flags_open_rule_dedup")
    .on(table.patient_id, table.rule_id)
    .where(sql`status = 'open' AND rule_id IS NOT NULL`),
  uniqueIndex("idx_flags_open_llm_dedup")
    .on(table.patient_id, table.category, table.severity)
    .where(sql`status = 'open' AND rule_id IS NULL`),
]);

export const clinicalRules = pgTable("clinical_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  conditions: jsonb("conditions").notNull(), // ClinicalRuleCondition[]
  severity: text("severity").notNull(),
  category: text("category").notNull(),
  suggested_action: text("suggested_action").notNull(),
  rationale_template: text("rationale_template").notNull(),
  enabled: integer("enabled").notNull().default(1),
  created_at: text("created_at").notNull(),
});

export const reviewJobs = pgTable("review_jobs", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed
  trigger_event_type: text("trigger_event_type").notNull(),
  trigger_event_id: text("trigger_event_id").notNull(),
  context_hash: text("context_hash"),
  rules_evaluated: jsonb("rules_evaluated").$type<string[]>().default([]),
  rules_fired: jsonb("rules_fired").$type<string[]>().default([]),
  // Full rule-evaluation output: for each fired rule we persist the exact
  // RuleFlag (severity, category, summary, rationale, suggested_action,
  // notify_specialties, rule_id) so regulatory and forensic audits can
  // reconstruct the decision without replaying the rule engine against
  // (possibly-mutated) patient state. See migration 0032.
  rules_output: jsonb("rules_output").$type<Array<Record<string, unknown>>>().default([]),
  llm_request_tokens: integer("llm_request_tokens"),
  llm_response_tokens: integer("llm_response_tokens"),
  redacted_prompt: text("redacted_prompt"),
  redaction_audit: jsonb("redaction_audit"),
  flags_generated: jsonb("flags_generated").$type<string[]>().default([]),
  processing_time_ms: integer("processing_time_ms"),
  error: text("error"),
  completed_at: text("completed_at"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_review_jobs_patient").on(table.patient_id, table.status),
]);
