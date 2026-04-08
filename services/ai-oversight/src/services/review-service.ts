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

import { eq, desc, gte, and } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  reviewJobs,
  diagnoses,
  medications,
  patients,
  labPanels,
  labResults,
} from "@carebridge/db-schema";
import type { ClinicalEvent, FlagSource } from "@carebridge/shared-types";
import {
  CLINICAL_REVIEW_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildReviewPrompt,
  enforceTokenBudget,
} from "@carebridge/ai-prompts";
import type { LLMFlagOutput } from "@carebridge/ai-prompts";
import {
  redactClinicalText,
  validateLLMResponse,
} from "@carebridge/phi-sanitizer";

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns } from "../rules/cross-specialty.js";
import type { PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";
import type { RuleFlag } from "../rules/critical-values.js";
import { buildPatientContext } from "../workers/context-builder.js";
import { isLLMEnabled, reviewPatientRecord, LLMDisabledError } from "./claude-client.js";
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
    redacted_prompt: null,
    redaction_audit: null,
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
        rule_id: ruleFlag.rule_id,
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

    // Step 4: LLM review path — gated on the kill-switch. When disabled,
    // deterministic rules still fire above; we just skip the LLM step and
    // mark the job completed. This is the operator's failsafe: disabling
    // LLM review must NEVER break the review pipeline.
    if (!isLLMEnabled()) {
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
        `[review-service] Job ${jobId} completed in ${processingTime}ms (rules-only; LLM kill-switch engaged). ` +
          `Rules fired: ${rulesFired.length}, Total flags: ${flagIds.length}`,
      );
      return;
    }

    const reviewContext = await buildPatientContext(event.patient_id, event);

    // Step 5: Build LLM prompt and enforce token budget
    const rawPrompt = buildReviewPrompt(reviewContext);
    const budgetResult = enforceTokenBudget(rawPrompt);

    if (budgetResult.truncated) {
      console.warn(
        `[review-service] Token budget exceeded for patient ${event.patient_id}. ` +
          `Original: ${budgetResult.originalTokens} tokens, ` +
          `Final: ${budgetResult.finalTokens} tokens. ` +
          `Sections trimmed: ${budgetResult.sectionsRemoved.join(", ")}`,
      );
    }

    // Fetch patient name so it can be redacted. The DB layer decrypts
    // `name` transparently on read.
    const patientRow = await db.query.patients.findFirst({
      where: eq(patients.id, event.patient_id),
    });

    // Redact PHI from the assembled prompt before sending to the Claude API
    const redactionResult = redactClinicalText(budgetResult.prompt, {
      providerNames: reviewContext.care_team?.map((m) => m.name).filter(Boolean) as string[] | undefined,
      patientAge: reviewContext.patient?.age,
      patientName: patientRow?.name ?? undefined,
      facilityNames: [],
      referenceDate: new Date(),
    });

    if (redactionResult.auditTrail.fieldsRedacted > 0) {
      const a = redactionResult.auditTrail;
      console.info(
        `[review-service] PHI redaction: ${a.fieldsRedacted} field(s) redacted ` +
          `(providers: ${a.providersRedacted}, ` +
          `ages: ${a.agesRedacted}, ` +
          `free-text: ${a.freeTextSanitized}, ` +
          `patient-names: ${a.patientNamesRedacted}, ` +
          `mrns: ${a.mrnsRedacted}, ` +
          `dates: ${a.datesRedacted}, ` +
          `facilities: ${a.facilitiesRedacted}, ` +
          `phones: ${a.phonesRedacted}, ` +
          `addresses: ${a.addressesRedacted}, ` +
          `ssns: ${a.ssnsRedacted}, ` +
          `icd10: ${a.icd10CodesRedacted}, ` +
          `snomed: ${a.snomedCodesRedacted})`,
      );
    }

    const userMessage = redactionResult.redactedText;

    // Persist the exact redacted prompt + audit trail for breach forensics
    // (HIPAA §164.308(a)(6)). Do this BEFORE the API call so we have a record
    // of what would have been transmitted even if the call fails.
    await db
      .update(reviewJobs)
      .set({
        redacted_prompt: userMessage,
        redaction_audit: redactionResult.auditTrail as unknown as Record<string, unknown>,
      })
      .where(eq(reviewJobs.id, jobId));

    // Step 6: Call Claude API. If the kill-switch flipped between the gate
    // check at Step 4 and here (env var race), gracefully complete as
    // rules-only rather than failing the job.
    let llmResponse: string;
    try {
      llmResponse = await reviewPatientRecord(
        CLINICAL_REVIEW_SYSTEM_PROMPT,
        userMessage,
      );
    } catch (err) {
      if (err instanceof LLMDisabledError) {
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
        console.warn(
          `[review-service] Job ${jobId} completed as rules-only after LLM kill-switch engaged mid-job: ${err.reason}`,
        );
        return;
      }
      throw err;
    }

    // Step 7: Validate and parse LLM response
    const validationResult = validateLLMResponse(llmResponse);

    if (!validationResult.ok) {
      throw new Error(`LLM response validation failed: ${validationResult.error}`);
    }

    if (validationResult.warnings.length > 0) {
      console.warn(
        `[review-service] LLM response warnings: ${validationResult.warnings.join("; ")}`,
      );
    }

    const llmFindings: LLMFlagOutput[] = validationResult.flags.map((f) => ({
      severity: f.severity,
      category: f.category,
      summary: f.summary,
      rationale: f.rationale,
      suggested_action: f.suggested_action,
      notify_specialties: f.notify_specialties,
    }));

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
        `Total flags: ${flagIds.length}` +
        (budgetResult.truncated ? ` (prompt truncated: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens} tokens)` : ""),
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
export async function buildPatientContextForRules(
  patientId: string,
  event: ClinicalEvent,
): Promise<PatientContext> {
  const db = getDb();

  // Recent labs window — rules like CHEMO-FEVER-001 (ANC-aware) need lab
  // values from the last 48h. Keep the window tight so we don't pick up
  // stale baseline values.
  const LAB_WINDOW_HOURS = 48;
  const labCutoff = new Date(
    Date.now() - LAB_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const [activeDiagnoses, activeMeds, recentLabRows] = await Promise.all([
    db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
    db.select().from(medications).where(eq(medications.patient_id, patientId)),
    // Join lab_results → lab_panels → filter by patient and freshness.
    // Single round-trip, no N+1.
    db
      .select({
        test_name: labResults.test_name,
        value: labResults.value,
        created_at: labResults.created_at,
      })
      .from(labResults)
      .innerJoin(labPanels, eq(labResults.panel_id, labPanels.id))
      .where(
        and(
          eq(labPanels.patient_id, patientId),
          gte(labResults.created_at, labCutoff),
        ),
      )
      .orderBy(desc(labResults.created_at)),
  ]);

  // Extract new symptoms from the event data
  const newSymptoms = extractSymptoms(event);

  const activeDx = activeDiagnoses.filter((d) => d.status === "active");

  // Dedupe recent labs by test_name, keeping the freshest value per name.
  // labRows are ordered desc by created_at, so the first occurrence wins.
  const seenLabs = new Set<string>();
  const recentLabs: Array<{ name: string; value: number }> = [];
  for (const row of recentLabRows) {
    if (seenLabs.has(row.test_name)) continue;
    seenLabs.add(row.test_name);
    recentLabs.push({ name: row.test_name, value: row.value });
  }

  return {
    active_diagnoses: activeDx.map((d) => d.description),
    active_diagnosis_codes: activeDx.map((d) => d.icd10_code ?? ""),
    active_medications: activeMeds
      .filter((m) => m.status === "active")
      .map((m) => m.name),
    new_symptoms: newSymptoms,
    care_team_specialties: [], // Not needed for current rules, but available for future
    trigger_event: event,
    recent_labs: recentLabs.length > 0 ? recentLabs : undefined,
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
 * Check if an LLM finding duplicates an existing rule-based flag from the current job.
 *
 * Uses word-overlap heuristic: if the LLM finding's summary shares significant
 * overlap with any rule flag's summary, consider it a duplicate. The former
 * category+severity catch-all has been removed — it incorrectly suppressed
 * distinct findings that happened to share the same severity and category.
 * DB-level deduplication in createFlag() handles cross-job duplicates.
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
  }

  return false;
}
