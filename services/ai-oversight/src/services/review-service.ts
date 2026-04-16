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
  allergies,
  messages,
  patientObservations,
  labPanels,
  labResults,
  encounters,
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
  redactPatientId,
  validateLLMResponse,
} from "@carebridge/phi-sanitizer";

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns } from "../rules/cross-specialty.js";
import type { PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";
import { screenPatientMessage } from "../rules/message-screening.js";
import { screenPatientObservation } from "../rules/observation-screening.js";
import { checkAllergyMedication } from "../rules/allergy-medication.js";
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

  // Idempotency: if a completed review already exists for this trigger event,
  // skip. BullMQ can re-deliver a job when a worker crashes mid-processing
  // (lock expires → stalled-scan reclaims the job) or the same event is
  // replayed via the outbox reconciler. Without this check each redelivery
  // writes an extra review_jobs row and — for rules whose dedup cannot cover
  // the replay window — potentially duplicate flags.
  const existingCompleted = await db
    .select({ id: reviewJobs.id, status: reviewJobs.status })
    .from(reviewJobs)
    .where(
      and(
        eq(reviewJobs.trigger_event_id, event.id),
        eq(reviewJobs.status, "completed"),
      ),
    )
    .limit(1);

  if (existingCompleted.length > 0) {
    console.log(
      `[review-service] Skipping duplicate review for event ${event.id} ` +
        `(prior completed job ${existingCompleted[0]!.id})`,
    );
    return;
  }

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

    // 2d. Allergy-medication cross-check
    rulesEvaluated.push("allergy-medication");
    const allergyFlags = checkAllergyMedication(patientContext);
    if (allergyFlags.length > 0) {
      rulesFired.push("allergy-medication");
      allRuleFlags.push(...allergyFlags);
    }

    // 2e. Patient message screening (only for message.received events)
    // Read message body from DB (encrypted at rest, Drizzle decrypts transparently)
    // rather than from the event payload (which correctly omits PHI).
    if (event.type === "message.received" && event.data.message_id) {
      rulesEvaluated.push("message-screening");

      const [msg] = await db.select({ body: messages.body })
        .from(messages)
        .where(eq(messages.id, event.data.message_id as string))
        .limit(1);

      if (msg?.body) {
        const enrichedEvent = {
          ...event,
          data: { ...event.data, message_text: msg.body },
        };
        const messageFlags = screenPatientMessage(enrichedEvent);
        if (messageFlags.length > 0) {
          rulesFired.push("message-screening");
          allRuleFlags.push(...messageFlags);
        }
      }
    }

    // 2f. Patient observation screening (only for patient.observation events)
    // Dedicated keyword rules for observation descriptions (symptom journal).
    // Ensures deterministic safety coverage even when the LLM layer is unavailable.
    if (event.type === "patient.observation" && event.data.observation_id) {
      rulesEvaluated.push("observation-screening");

      const [obs] = await db.select({ description: patientObservations.description })
        .from(patientObservations)
        .where(eq(patientObservations.id, event.data.observation_id as string))
        .limit(1);

      if (obs?.description) {
        const enrichedEvent = {
          ...event,
          data: { ...event.data, observation_description: obs.description },
        };
        const obsFlags = screenPatientObservation(enrichedEvent);
        if (obsFlags.length > 0) {
          rulesFired.push("observation-screening");
          allRuleFlags.push(...obsFlags);
        }
      }
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

    // Step 4: Build patient context for LLM review
    const reviewContext = await buildPatientContext(event.patient_id, event);

    // Step 5: Build LLM prompt and enforce token budget
    const rawPrompt = buildReviewPrompt(reviewContext);
    const budgetResult = enforceTokenBudget(rawPrompt);

    if (budgetResult.truncated) {
      console.warn(
        `[review-service] Token budget exceeded for patient ${redactPatientId(event.patient_id)}. ` +
          `Original: ${budgetResult.originalTokens} tokens, ` +
          `Final: ${budgetResult.finalTokens} tokens. ` +
          `Sections trimmed: ${budgetResult.sectionsRemoved.join(", ")}`,
      );
    }

    // Fetch patient name and facility/location names so they can be redacted.
    // The DB layer decrypts `name` transparently on read.
    const [patientRow, patientEncounters] = await Promise.all([
      db.query.patients.findFirst({
        where: eq(patients.id, event.patient_id),
      }),
      db
        .select({ location: encounters.location })
        .from(encounters)
        .where(eq(encounters.patient_id, event.patient_id)),
    ]);

    // Collect unique, non-empty facility/location names for redaction
    const facilityNames = [
      ...new Set(
        patientEncounters
          .map((e) => e.location)
          .filter((loc): loc is string => typeof loc === "string" && loc.trim().length > 0),
      ),
    ];

    // Redact PHI from the assembled prompt before sending to the Claude API
    const redactionResult = redactClinicalText(budgetResult.prompt, {
      providerNames: reviewContext.care_team?.map((m) => m.name).filter(Boolean) as string[] | undefined,
      patientAge: reviewContext.patient?.age,
      patientName: patientRow?.name ?? undefined,
      facilityNames,
      referenceDate: new Date(),
    });

    if (redactionResult.auditTrail.fieldsRedacted > 0) {
      console.info(
        `[review-service] PHI redaction: ${redactionResult.auditTrail.fieldsRedacted} field(s) redacted ` +
          `(providers: ${redactionResult.auditTrail.providersRedacted}, ` +
          `ages: ${redactionResult.auditTrail.agesRedacted}, ` +
          `free-text: ${redactionResult.auditTrail.freeTextSanitized})`,
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

    // Step 6: Call Claude API (with fallback on timeout/outage)
    let llmFindings: LLMFlagOutput[] = [];
    let llmFailed = false;
    let llmFailureStatus: "llm_timeout" | "llm_error" | null = null;
    let llmErrorMessage: string | null = null;

    try {
      const llmResponse = await reviewPatientRecord(
        CLINICAL_REVIEW_SYSTEM_PROMPT,
        userMessage,
      );

      // Step 7: Validate and parse LLM response
      const validationResult = validateLLMResponse(llmResponse);

      if (!validationResult.ok) {
        console.error(
          `[review-service] LLM response validation failed for job ${jobId}: ${validationResult.error}. ` +
            `Raw response (first 500 chars): ${llmResponse.slice(0, 500)}`,
        );
        throw new Error(`LLM response validation failed: ${validationResult.error}`);
      }

      if (validationResult.warnings.length > 0) {
        console.warn(
          `[review-service] LLM response warnings: ${validationResult.warnings.join("; ")}`,
        );
      }

      llmFindings = validationResult.flags.map((f) => ({
        severity: f.severity,
        category: f.category,
        summary: f.summary,
        rationale: f.rationale,
        suggested_action: f.suggested_action,
        notify_specialties: f.notify_specialties,
      }));
    } catch (llmError) {
      llmFailed = true;
      llmErrorMessage =
        llmError instanceof Error ? llmError.message : String(llmError);

      const isValidationFailure =
        llmErrorMessage.includes("LLM response validation failed");

      const isTimeout =
        llmErrorMessage.includes("timed out") ||
        llmErrorMessage.includes("timeout") ||
        llmErrorMessage.includes("ETIMEDOUT") ||
        llmErrorMessage.includes("ECONNABORTED");

      llmFailureStatus = isTimeout ? "llm_timeout" : "llm_error";

      console.error(
        `[review-service] LLM review failed for job ${jobId} ` +
          `(status: ${llmFailureStatus}, patient: ${event.patient_id}, ` +
          `event: ${event.type}/${event.id}): ${llmErrorMessage}`,
      );

      if (isValidationFailure) {
        const fallbackFlag = await createFlag({
          patient_id: event.patient_id,
          source: "ai-review" as FlagSource,
          severity: "warning",
          category: "care-gap" as ClinicalFlagCategory,
          summary: "AI review could not be completed \u2014 LLM response was malformed",
          rationale:
            `The automated clinical review for event ${event.type} (${event.id}) ` +
            `could not parse the LLM response. Parse error: ${llmErrorMessage}. ` +
            `Deterministic rules still ran, but the deeper LLM analysis was not applied. ` +
            `A clinician should manually review this event.`,
          suggested_action:
            "Manually review the triggering clinical event for any concerns " +
            "that automated rules may not catch.",
          notify_specialties: [],
          trigger_event_ids: [event.id],
          status: "open",
          model_id: "claude-sonnet-4-6",
          prompt_version: PROMPT_VERSION,
          requires_human_review: true,
        });
        flagIds.push(fallbackFlag.id);
      } else {
        const fallbackFlag = await createFlag({
          patient_id: event.patient_id,
          source: "ai-review" as FlagSource,
          severity: "info",
          category: "care-gap" as ClinicalFlagCategory,
          summary:
            "AI review unavailable \u2014 deterministic rules applied, LLM review deferred",
          rationale:
            `The Claude API was unreachable or timed out during review of event ${event.type}. ` +
            `Deterministic safety rules were evaluated normally. LLM-based review did not run ` +
            `and may catch additional patterns once the service recovers.`,
          suggested_action:
            "No immediate action required. Deterministic rules have been applied. " +
            "LLM review will run on subsequent clinical events.",
          notify_specialties: [],
          trigger_event_ids: [event.id],
          status: "open",
          requires_human_review: false,
        });
        flagIds.push(fallbackFlag.id);
      }
    }

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

    // Step 9: Update review_jobs record
    const processingTime = Date.now() - startTime;
    const jobStatus = llmFailed ? llmFailureStatus! : "completed";

    await db
      .update(reviewJobs)
      .set({
        status: jobStatus,
        rules_evaluated: rulesEvaluated,
        rules_fired: rulesFired,
        flags_generated: flagIds,
        processing_time_ms: processingTime,
        ...(llmFailed ? { error: llmErrorMessage } : {}),
        completed_at: new Date().toISOString(),
      })
      .where(eq(reviewJobs.id, jobId));

    if (llmFailed) {
      console.warn(
        `[review-service] Job ${jobId} completed with ${jobStatus} in ${processingTime}ms. ` +
          `Rules fired: ${rulesFired.length}, LLM skipped, ` +
          `Total flags: ${flagIds.length} (includes fallback)`,
      );
    } else {
      console.log(
        `[review-service] Job ${jobId} completed in ${processingTime}ms. ` +
          `Rules fired: ${rulesFired.length}, LLM findings: ${llmFindings.length}, ` +
          `Total flags: ${flagIds.length}` +
          (budgetResult.truncated ? ` (prompt truncated: ${budgetResult.originalTokens} -> ${budgetResult.finalTokens} tokens)` : ""),
      );
    }
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

  const [activeDiagnoses, activeMeds, patientAllergies, recentLabRows] = await Promise.all([
    db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
    db.select().from(medications).where(eq(medications.patient_id, patientId)),
    db.select().from(allergies).where(eq(allergies.patient_id, patientId)),
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

  const activeMedsList = activeMeds.filter((m) => m.status === "active");

  return {
    active_diagnoses: activeDx.map((d) => d.description),
    active_diagnosis_codes: activeDx.map((d) => d.icd10_code ?? ""),
    active_medications: activeMedsList.map((m) => m.name),
    active_medication_rxnorm_codes: activeMedsList.map((m) => m.rxnorm_code),
    new_symptoms: newSymptoms,
    care_team_specialties: [], // Not needed for current rules, but available for future
    allergies: patientAllergies.map((a) => ({
      allergen: a.allergen,
      rxnorm_code: a.rxnorm_code,
      severity: a.severity,
      reaction: a.reaction,
    })),
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
 * Severity order used for LLM-vs-rule precedence decisions.
 * Rank higher = more important.
 *
 * Exported for unit testing.
 */
export function severityRank(severity: string): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

/**
 * Category ordering for precedence decisions. A rule flag in a higher-
 * precedence category takes primacy when both fire on the same concept.
 *
 * Values ordered by clinical urgency using the full FlagCategory set from
 * `@carebridge/shared-types`:
 *
 *   critical-value          — directly reported abnormal (e.g. K+ 7.0).
 *                             Requires immediate action. Highest rank.
 *   medication-safety       — drug/allergy/contraindication. High blast
 *                             radius if missed.
 *   drug-interaction        — drug/drug interaction. Safety-equivalent to
 *                             medication-safety, treated at the same tier.
 *   cross-specialty         — multi-specialty pattern.
 *   trend-concern           — decline observed over time.
 *   patient-reported        — patient-provided symptom.
 *   documentation-discrepancy — record missing/inconsistent.
 *   care-gap                — preventive gap. Lowest urgency.
 *
 * Exported for unit testing.
 */
export function categoryRank(category: string): number {
  switch (category) {
    case "critical-value":
      return 8;
    case "medication-safety":
      return 7;
    case "drug-interaction":
      return 7; // safety-equivalent to medication-safety
    case "cross-specialty":
      return 5;
    case "trend-concern":
      return 4;
    case "patient-reported":
      return 3;
    case "documentation-discrepancy":
      return 2;
    case "care-gap":
      return 1;
    default:
      return 0;
  }
}

/** Normalize a summary into a Set of significant lowercase words. */
function significantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  );
}

/**
 * Jaccard-style word overlap between two summaries. Returns a value in
 * [0, 1] indicating how much the two summaries describe the same concept.
 */
function summaryOverlap(a: string, b: string): number {
  const setA = significantWords(a);
  const setB = significantWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  const union = new Set([...setA, ...setB]).size;
  return shared / union;
}

/**
 * Decide whether an LLM finding should be dropped as a duplicate of an
 * existing deterministic rule flag.
 *
 * Drop only when the LLM finding is fully subsumed by an existing rule
 * flag — i.e. same concept, no higher severity, no new specialty, no
 * higher-precedence category. Otherwise keep both because the LLM is
 * adding value (escalation, comorbidity context, or a new notify target).
 *
 * Exported for unit testing. Replaces the prior 40% word-overlap-only
 * heuristic, which suppressed LLM findings that added clinical context
 * or escalated severity. See #266.
 */
export function shouldDropAsDuplicate(
  finding: LLMFlagOutput,
  ruleFlags: readonly RuleFlag[],
): boolean {
  // A high-severity LLM finding is NEVER dropped — the extra review is
  // the floor we want regardless of rule-flag overlap.
  if (finding.severity === "critical") return false;

  const findingSpecialties = new Set(finding.notify_specialties ?? []);
  const findingSeverity = severityRank(finding.severity);
  const findingCategory = categoryRank(finding.category);

  // Scan the FULL rule-flag list and drop only if some rule subsumes the
  // finding. An earlier loop returned `false` (keep) as soon as it saw a
  // single non-subsuming match — which missed the case where rule_flags
  // contained both a non-subsuming version (e.g. info-severity same topic)
  // AND a subsuming version (e.g. matching-severity same topic). The
  // subsuming match must win.
  for (const ruleFlag of ruleFlags) {
    const overlap = summaryOverlap(finding.summary, ruleFlag.summary);

    // Same-concept threshold. Raised from 0.40 (the prior bug) to 0.60
    // of the Jaccard overlap so shared function words ("patient",
    // "fever", "with") don't false-positive on distinct findings.
    if (overlap < 0.6) continue;

    // LLM escalates severity over this rule flag — this rule is not a
    // subsuming match, but keep scanning in case a later one is.
    const ruleSeverity = severityRank(ruleFlag.severity);
    if (findingSeverity > ruleSeverity) continue;

    // LLM claims a higher-precedence category on the same concept — not
    // subsumed by this rule flag, but keep scanning.
    if (findingCategory > categoryRank(ruleFlag.category)) continue;

    // LLM adds a notify specialty this rule flag doesn't have — not
    // subsumed by this rule flag, but keep scanning.
    const ruleSpecialties = new Set(ruleFlag.notify_specialties ?? []);
    let addsNewSpecialty = false;
    for (const s of findingSpecialties) {
      if (!ruleSpecialties.has(s)) {
        addsNewSpecialty = true;
        break;
      }
    }
    if (addsNewSpecialty) continue;

    // Fully subsumed by this rule flag: same concept, not escalating, not
    // upgrading category, not adding a specialty. Drop the LLM finding.
    return true;
  }

  return false;
}

/**
 * Backwards-compatible alias so call sites that still use the old name
 * keep compiling. New code should prefer shouldDropAsDuplicate.
 */
function isDuplicate(
  finding: LLMFlagOutput,
  ruleFlags: readonly RuleFlag[],
): boolean {
  return shouldDropAsDuplicate(finding, ruleFlags);
}
