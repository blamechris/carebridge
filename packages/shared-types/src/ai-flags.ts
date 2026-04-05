import type { BaseRecord } from "./base.js";

// ─── Clinical Flags ──────────────────────────────────────────────

export type FlagSource = "rules" | "ai-review";
export type FlagSeverity = "critical" | "warning" | "info";
export type FlagCategory =
  | "cross-specialty"
  | "drug-interaction"
  | "care-gap"
  | "critical-value"
  | "trend-concern"
  | "documentation-discrepancy";
export type FlagStatus = "open" | "acknowledged" | "resolved" | "dismissed" | "escalated";

export interface ClinicalFlag extends BaseRecord {
  patient_id: string;
  source: FlagSource;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
  trigger_event_ids: string[];
  status: FlagStatus;
  resolution_note?: string;
  acknowledged_by?: string;
  acknowledged_at?: string;
  resolved_by?: string;
  resolved_at?: string;
  dismissed_by?: string;
  dismissed_at?: string;
  dismiss_reason?: string;
  model_id?: string;
  prompt_version?: string;
}

// ─── Clinical Rules ──────────────────────────────────────────────

export interface ClinicalRuleCondition {
  field: string;
  operator: "equals" | "contains" | "in" | "gt" | "lt" | "exists" | "icd10_range";
  value: string | number | string[];
}

export interface ClinicalRule {
  id: string;
  name: string;
  description: string;
  conditions: ClinicalRuleCondition[];
  severity: FlagSeverity;
  category: FlagCategory;
  suggested_action: string;
  rationale_template: string;
  enabled: boolean;
}

// ─── Review Jobs ─────────────────────────────────────────────────

export type ReviewStatus = "pending" | "processing" | "completed" | "failed";

export interface ReviewJob extends BaseRecord {
  patient_id: string;
  status: ReviewStatus;
  trigger_event_type: string;
  trigger_event_id: string;
  context_hash?: string;
  rules_evaluated: string[];
  rules_fired: string[];
  llm_request_tokens?: number;
  llm_response_tokens?: number;
  flags_generated: string[];
  processing_time_ms?: number;
  error?: string;
  completed_at?: string;
}

// ─── Clinical Events (for the event bus) ─────────────────────────

export type ClinicalEventType =
  | "vital.created"
  | "vital.updated"
  | "lab.resulted"
  | "medication.created"
  | "medication.updated"
  | "note.saved"
  | "note.signed"
  | "medication.administered"
  | "procedure.completed"
  | "diagnosis.added"
  | "fhir.imported";

export interface ClinicalEvent {
  id: string;
  type: ClinicalEventType;
  patient_id: string;
  provider_id?: string;
  data: Record<string, unknown>;
  timestamp: string;
}
