/**
 * Review orchestration service.
 *
 * This is the pipeline that ties everything together:
 *   1. Deterministic rules fire first (fast, no API call)
 *   2. LLM review runs second (deeper analysis, catches subtler patterns)
 *   3. Deduplication ensures we don't create redundant flags
 *
 * The review_jobs table records every run for auditability.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import { reviewJobs, diagnoses, medications } from "@carebridge/db-schema";
import type { ClinicalEvent, FlagSource } from "@carebridge/shared-types";
import {
  CLINICAL_REVIEW_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildReviewPrompt,
  parseReviewResponse,
} from "@carebridge/ai-prompts";
import type { LLMFlagOutput } from "@carebridge/ai-prompts";

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns } from "../rules/cross-specialty.js";
import type { PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";
import type { RuleFlag } from "../rules/critical-values.js";
import { buildPatientContext } from "../workers/context-builder.js";
import { reviewPatientRecord } from "./claude-client.js";
import { createFlag } from "./flag-service.js";

/**
 * Process a clinical event through the full review pipeline.
 */
export async function processReviewJob(event: ClinicalEvent): Promise<void> {
  const db = getDb();
  const jobId = crypto.randomUUID();
  const startTime = Date.now();

  // Step 1: Create a review_jobs record
  await db.insert(reviewJobs).values({
    id: jobId,
    patient_id: event.patient_id,
    status: "processing",
    trigger_event_type: event.type,
    trigger_event_id: event.id,
    rules_evaluated: [],
    rules_fired: [],
    flags_generated: [],
    created_at: new Date().toISOString(),
  });

  try {
    const allRuleFlags: RuleFlag[] = [];
    const rulesEvaluated: string[] = [];
    const rulesFired: string[] = [];
    const flagIds: string[] = [];

    // Step 2: Run deterministic rules

    // 2a. Critical values check
    rulesEvaluated.push("critical-values");
    const criticalValueFlags = checkCriticalValues(event);
    if (criticalValueFlags.length > 0) {
      rulesFired.push("critical-values");
      allRuleFlags.push(...criticalValueFlags);
    }

    // 2b. Cross-specialty patterns — need patient context from DB
    rulesEvaluated.push("cross-specialty");
    const patientContext = await buildPatientContextForRules(event.patient_id, event);
    const crossSpecialtyFlags = checkCrossSpecialtyPatterns(patientContext);
    if (crossSpecialtyFlags.length > 0) {
      rulesFired.push("cross-specialty");
      allRuleFlags.push(...crossSpecialtyFlags);
    }

    // 2c. Drug interactions
    rulesEvaluated.push("drug-interactions");
    const drugFlags = checkDrugInteractions(patientContext.active_medications);
    if (drugFlags.length > 0) {
      rulesFired.push("drug-interactions");
      allRuleFlags.push(...drugFlags);
    }

    // Step 3: Create flags for rule matches
    for (const ruleFlag of allRuleFlags) {
      const flag = await createFlag({
        patient_id: event.patient_id,
        source: "rules" as FlagSource,
        severity: ruleFlag.severity,
        category: ruleFlag.category,
        summary: ruleFlag.summary,
        rationale: ruleFlag.rationale,
        suggested_action: ruleFlag.suggested_action,
        notify_specialties: ruleFlag.notify_specialties,
        trigger_event_ids: [event.id],
        status: "open",
      });
      flagIds.push(flag.id);
    }

    // Step 4: Build patient context for LLM review
    const reviewContext = await buildPatientContext(event.patient_id, event);

    // Step 5: Build LLM prompt
    const userMessage = buildReviewPrompt(reviewContext);

    // Step 6: Call Claude API
    const llmResponse = await reviewPatientRecord(
      CLINICAL_REVIEW_SYSTEM_PROMPT,
      userMessage,
    );

    // Step 7: Parse response
    const llmFindings = parseReviewResponse(llmResponse);

    // Step 8: Create flags for LLM findings (deduplicate against rule-based flags)
    for (const finding of llmFindings) {
      if (isDuplicate(finding, allRuleFlags)) {
        continue;
      }

      const flag = await createFlag({
        patient_id: event.patient_id,
        source: "ai-review" as FlagSource,
        severity: finding.severity,
        category: finding.category as ClinicalFlagCategory,
        summary: finding.summary,
        rationale: finding.rationale,
        suggested_action: finding.suggested_action,
        notify_specialties: finding.notify_specialties,
        trigger_event_ids: [event.id],
        status: "open",
        model_id: "claude-sonnet-4-6",
        prompt_version: PROMPT_VERSION,
      });
      flagIds.push(flag.id);
    }

    // Step 9: Update review_jobs record — completed
    const processingTime = Date.now() - startTime;
    await db
      .update(reviewJobs)
      .set({
        status: "completed",
        rules_evaluated: rulesEvaluated,
        rules_fired: rulesFired,
        flags_generated: flagIds,
        processing_time_ms: processingTime,
        completed_at: new Date().toISOString(),
      })
      .where(eq(reviewJobs.id, jobId));

    console.log(
      `[review-service] Job ${jobId} completed in ${processingTime}ms. ` +
        `Rules fired: ${rulesFired.length}, LLM findings: ${llmFindings.length}, ` +
        `Total flags: ${flagIds.length}`,
    );
  } catch (error) {
    // Step 10: Update review_jobs — failed
    const processingTime = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    await db
      .update(reviewJobs)
      .set({
        status: "failed",
        error: errorMessage,
        processing_time_ms: processingTime,
        completed_at: new Date().toISOString(),
      })
      .where(eq(reviewJobs.id, jobId));

    console.error(
      `[review-service] Job ${jobId} failed after ${processingTime}ms: ${errorMessage}`,
    );

    throw error;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

// Type alias for readability
type ClinicalFlagCategory = import("@carebridge/shared-types").FlagCategory;

/**
 * Build a lightweight PatientContext for the deterministic cross-specialty rules.
 * This extracts what the rules need from the database without the full ReviewContext overhead.
 */
async function buildPatientContextForRules(
  patientId: string,
  event: ClinicalEvent,
): Promise<PatientContext> {
  const db = getDb();

  const [activeDiagnoses, activeMeds] = await Promise.all([
    db
      .select()
      .from(diagnoses)
      .where(
        eq(diagnoses.patient_id, patientId),
      ),
    db
      .select()
      .from(medications)
      .where(
        eq(medications.patient_id, patientId),
      ),
  ]);

  // Extract new symptoms from the event data
  const newSymptoms = extractSymptoms(event);

  return {
    active_diagnoses: activeDiagnoses
      .filter((d) => d.status === "active")
      .map((d) => d.description),
    active_medications: activeMeds
      .filter((m) => m.status === "active")
      .map((m) => m.name),
    new_symptoms: newSymptoms,
    care_team_specialties: [], // Not needed for current rules, but available for future
  };
}

/**
 * Extract symptom strings from a clinical event.
 */
function extractSymptoms(event: ClinicalEvent): string[] {
  const symptoms: string[] = [];

  // New symptoms can come from various event types
  if (event.data.symptoms && Array.isArray(event.data.symptoms)) {
    symptoms.push(
      ...(event.data.symptoms as string[]),
    );
  }
  if (event.data.chief_complaint && typeof event.data.chief_complaint === "string") {
    symptoms.push(event.data.chief_complaint);
  }
  if (event.data.new_symptoms && Array.isArray(event.data.new_symptoms)) {
    symptoms.push(
      ...(event.data.new_symptoms as string[]),
    );
  }
  // For vital events, the vital type itself can be informative
  if (event.type === "vital.created" && event.data.notes) {
    symptoms.push(event.data.notes as string);
  }
  // For note events, extract from sections if available
  if (
    (event.type === "note.saved" || event.type === "note.signed") &&
    event.data.subjective &&
    typeof event.data.subjective === "string"
  ) {
    symptoms.push(event.data.subjective);
  }

  return symptoms;
}

/**
 * Check if an LLM finding duplicates an existing rule-based flag.
 *
 * We use a simple heuristic: if the LLM finding's summary shares significant
 * overlap with any rule flag's summary, consider it a duplicate.
 */
function isDuplicate(
  finding: LLMFlagOutput,
  ruleFlags: RuleFlag[],
): boolean {
  const findingWords = new Set(
    finding.summary.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  );

  for (const ruleFlag of ruleFlags) {
    const ruleWords = ruleFlag.summary
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    // Count overlapping significant words
    let overlap = 0;
    for (const word of ruleWords) {
      if (findingWords.has(word)) overlap++;
    }

    // If more than 40% of the rule flag's significant words appear in the
    // LLM finding, consider it a duplicate
    if (ruleWords.length > 0 && overlap / ruleWords.length > 0.4) {
      return true;
    }

    // Also check category + severity match for same patient concern
    if (
      finding.category === ruleFlag.category &&
      finding.severity === ruleFlag.severity
    ) {
      return true;
    }
  }

  return false;
}
