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

import { eq, desc, gte, lte, gt, and, inArray, or, ne, sql } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  reviewJobs,
  diagnoses,
  medications,
  patients,
  allergies,
  allergyOverrides,
  clinicalFlags,
  messages,
  patientObservations,
  labPanels,
  labResults,
  encounters,
} from "@carebridge/db-schema";
import type { ClinicalEvent, FlagSource, RuleFlag } from "@carebridge/shared-types";
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
import { createLogger } from "@carebridge/logger";

const logger = createLogger("ai-oversight");

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns } from "../rules/cross-specialty.js";
import type { PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";
import { screenPatientMessage } from "../rules/message-screening.js";
import { screenPatientObservation } from "../rules/observation-screening.js";
import { checkAllergyMedication } from "../rules/allergy-medication.js";
import {
  isoBefore,
  isoLTE,
  isDiagnosisRetracted,
  isAllergyRetracted,
  isMedicationRetracted,
  isLabRetracted,
} from "../utils/event-time-snapshot.js";
import { buildPatientContext } from "../workers/context-builder.js";
import { validateEventTimestamp } from "../utils/validate-event-timestamp.js";
import { reviewPatientRecord } from "./claude-client.js";
import { createFlag } from "./flag-service.js";


/**
 * Statuses that represent a fully-run pipeline. A review_jobs row in any of
 * these states has already executed deterministic rules AND (for the two
 * `llm_*` statuses) attempted or intentionally skipped the LLM step — so
 * redelivering the triggering event must NOT re-execute. Adding a new
 * terminal status to the pipeline requires adding it here as well.
 *
 * Intentionally excludes:
 *   - `pending` / `processing`: non-terminal, handled by the in-flight
 *     freshness window below (see IN_FLIGHT_WINDOW_MS).
 *   - `failed`: the pipeline threw before flag writes; a retry IS desired.
 */
const TERMINAL_REVIEW_STATUSES: readonly string[] = [
  "completed",
  "llm_timeout",
  "llm_error",
];

/**
 * In-flight freshness window for the idempotency probe. A `processing`
 * row newer than this is treated as another worker actively running the
 * pipeline — we short-circuit rather than run a concurrent duplicate.
 * Older `processing` rows are treated as orphans (crashed worker) and
 * the pipeline proceeds normally.
 *
 * Chosen comfortably longer than BullMQ `lockDuration` (120s) so a live
 * worker still holding its Redis lock cannot have its row fall outside
 * the window. See #522.
 */
export const IN_FLIGHT_WINDOW_MS = 150_000;

/** IN_FLIGHT_WINDOW_MS expressed in whole seconds for PostgreSQL interval literals. */
export const IN_FLIGHT_WINDOW_SEC = Math.round(IN_FLIGHT_WINDOW_MS / 1000);

/**
 * Process a clinical event through the full review pipeline.
 */
export async function processReviewJob(event: ClinicalEvent): Promise<void> {
  const db = getDb();
  const jobId = crypto.randomUUID();
  const startTime = Date.now();

  // Idempotency: short-circuit if the pipeline has already run — or is
  // actively running — for this trigger event.
  //
  // BullMQ can re-deliver a job when a worker crashes mid-processing (lock
  // expires → stalled-scan reclaims the job) or the same event is replayed
  // via the outbox reconciler / a manual requeue. Without this check each
  // redelivery writes an extra review_jobs row and — for rules whose dedup
  // cannot cover the replay window — potentially duplicate flags.
  //
  // The probe matches two disjoint cases:
  //
  //   1) Terminal run: prior row in a "fully-run" status (completed,
  //      llm_timeout, llm_error). Re-running would either duplicate flags
  //      or re-call Claude for a degraded-LLM path we already logged.
  //      `failed` is intentionally NOT terminal — the pipeline threw before
  //      flag writes, so a retry is desired. See #520.
  //
  //   2) In-flight run: prior row in `processing` that is fresh
  //      (< IN_FLIGHT_WINDOW_MS old). Another worker is mid-pipeline for
  //      this event — running concurrently risks duplicate flags for any
  //      rule whose open-flag dedup can’t span the race window. Stale
  //      `processing` rows (orphans from crashed workers) fall outside
  //      the window and do NOT short-circuit — matching the prior
  //      behavior for crash recovery. See #522.
  const inFlightCutoff = sql`NOW() - ${IN_FLIGHT_WINDOW_SEC} * interval ‘1 second’`;

  const existingJob = await db
    .select({
      id: reviewJobs.id,
      status: reviewJobs.status,
      created_at: reviewJobs.created_at,
    })
    .from(reviewJobs)
    .where(
      and(
        eq(reviewJobs.trigger_event_id, event.id),
        or(
          inArray(reviewJobs.status, TERMINAL_REVIEW_STATUSES as string[]),
          and(
            eq(reviewJobs.status, "processing"),
            gte(reviewJobs.created_at, inFlightCutoff),
          ),
        ),
      ),
    )
    .limit(1);

  if (existingJob.length > 0) {
    const prior = existingJob[0]!;
    console.log(
      `[review-service] Skipping duplicate review for event ${event.id} ` +
        `(prior job ${prior.id}, status=${prior.status})`,
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

    // Step 2z: Consolidate rule flags (#854)
    //
    // Narrow dedup: when CRITICAL-LAB-POTASSIUM and CROSS-QT-HYPOK-001 both
    // fire for the same patient+review, suppress the critical-value flag in
    // favor of the cross-specialty flag. Both describe the same underlying
    // signal (severe hypokalemia → arrhythmia risk); the cross-specialty flag
    // is strictly more actionable because it names the QT-prolonging drug.
    // `allRuleFlags` is replaced with the consolidated list so downstream
    // persistence, audit, and LLM-dedup all operate on the deduped set.
    const consolidatedRuleFlags = consolidateRuleFlags(allRuleFlags);
    allRuleFlags.length = 0;
    allRuleFlags.push(...consolidatedRuleFlags);

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

      // Truncation is an alert-level event: the LLM produced more clinical
      // signal than we kept. Emit as console.error so ops dashboards surface
      // it distinct from generic warnings.
      if (validationResult.truncation) {
        const t = validationResult.truncation;
        console.error(
          `[review-service] ALERT: LLM findings truncated for job ${jobId} ` +
            `(patient: ${redactPatientId(event.patient_id)}, event: ${event.type}/${event.id}): ` +
            `received=${t.receivedCount}, kept=${t.keptCount}, dropped=${t.droppedCount} ` +
            `[critical=${t.droppedBySeverity.critical}, ` +
            `warning=${t.droppedBySeverity.warning}, info=${t.droppedBySeverity.info}]`,
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
        // Full rule output (severity, category, rationale, notify_specialties,
        // rule_id per match) — required for forensic/regulatory audit.
        // See #241 and migration 0032.
        rules_output: allRuleFlags,
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

  // TOCTOU fix — filter rows to their state AS OF event.timestamp, not as of
  // review time. Validated before use (#517) — malformed timestamps
  // fall back to `now` with a structured warning.
  const eventAt = validateEventTimestamp(event.timestamp, {
    eventId: event.id,
    caller: "review-service:buildPatientContextForRules",
  });

  // Recent labs window — rules like CHEMO-FEVER-001 (ANC-aware) need lab
  // values from the last 48h. Keep the window tight so we don't pick up
  // stale baseline values.
  const LAB_WINDOW_HOURS = 48;
  const labCutoff = new Date(
    Date.now() - LAB_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Push snapshot predicates into SQL (#514) to avoid fetching the full
  // patient history into application memory. The text-column timestamps
  // sort correctly under lexicographic compare for the Z-form values the
  // platform emits (ISO-8601 `YYYY-MM-DDTHH:MM:SS.sssZ`). Offset-form
  // and bare-date edge cases are caught by the in-memory filters below
  // which remain as a correctness backstop.
  const [
    allDiagnoses,
    allMeds,
    allAllergies,
    recentLabRows,
    overrideRows,
  ] = await Promise.all([
    db
      .select()
      .from(diagnoses)
      .where(
        and(
          eq(diagnoses.patient_id, patientId),
          ne(diagnoses.status, "entered_in_error"),
          or(
            sql`${diagnoses.onset_date} IS NULL`,
            lte(diagnoses.onset_date, eventAt),
          ),
          or(
            sql`${diagnoses.resolved_date} IS NULL`,
            gt(diagnoses.resolved_date, eventAt),
          ),
        ),
      ),
    db
      .select()
      .from(medications)
      .where(
        and(
          eq(medications.patient_id, patientId),
          ne(medications.status, "entered_in_error"),
          or(
            sql`${medications.started_at} IS NULL`,
            lte(medications.started_at, eventAt),
          ),
          or(
            sql`${medications.ended_at} IS NULL`,
            gt(medications.ended_at, eventAt),
          ),
        ),
      ),
    db
      .select()
      .from(allergies)
      .where(
        and(
          eq(allergies.patient_id, patientId),
          lte(allergies.created_at, eventAt),
          ne(allergies.verification_status, "entered_in_error"),
          ne(allergies.verification_status, "refuted"),
        ),
      ),
    // Join lab_results → lab_panels → filter by patient, freshness, and
    // event-time upper bound (#514). The `unit` column (#856) is selected
    // so unit-aware rule helpers can verify threshold comparisons are
    // against the canonical unit for each analyte.
    db
      .select({
        test_name: labResults.test_name,
        value: labResults.value,
        unit: labResults.unit,
        created_at: labResults.created_at,
        flag: labResults.flag,
      })
      .from(labResults)
      .innerJoin(labPanels, eq(labResults.panel_id, labPanels.id))
      .where(
        and(
          eq(labPanels.patient_id, patientId),
          gte(labResults.created_at, labCutoff),
          lte(labResults.created_at, eventAt),
        ),
      )
      .orderBy(desc(labResults.created_at)),
    // Allergy overrides (issue #233) — join to clinicalFlags so we can
    // recover the medication the override was granted against (stored in
    // the flag's summary) without a second round-trip. Only overrides
    // granted at or before the event are returned; TOCTOU-safe with the
    // rest of the snapshot. Left-joining the flag keeps overrides whose
    // triggering flag has been garbage-collected (defensive — shouldn't
    // happen because flags are never deleted, but the rule layer
    // degrades gracefully if it does).
    db
      .select({
        allergy_id: allergyOverrides.allergy_id,
        override_reason: allergyOverrides.override_reason,
        overridden_at: allergyOverrides.overridden_at,
        flag_summary: clinicalFlags.summary,
      })
      .from(allergyOverrides)
      .leftJoin(
        clinicalFlags,
        eq(allergyOverrides.flag_id, clinicalFlags.id),
      )
      .where(
        and(
          eq(allergyOverrides.patient_id, patientId),
          lte(allergyOverrides.overridden_at, eventAt),
        ),
      ),
  ]);

  // Extract new symptoms from the event data
  const newSymptoms = extractSymptoms(event);

  // In-memory backstop — the SQL predicates above use lexicographic text
  // comparison which handles Z-form correctly but may mis-sort offset-form
  // (-05:00) or bare-date (2025-12-01) timestamps. The in-memory filters
  // below use Date.parse-normalized comparisons (isoBefore/isoLTE) to catch
  // any rows that slipped through. See #513.
  function wasActiveAt(
    row: {
      onset_date?: string | null;
      resolved_date?: string | null;
      status?: string | null;
      created_at: string;
    },
    at: string,
  ): boolean {
    // Logical retraction (#515): a diagnosis marked entered_in_error is a
    // charting correction and must never appear in the active set,
    // regardless of its onset/resolved timestamps.
    if (isDiagnosisRetracted(row)) return false;
    const start = row.onset_date ?? row.created_at;
    if (isoBefore(at, start)) return false; // not yet started at event time
    if (row.resolved_date && isoLTE(row.resolved_date, at)) return false; // resolved before event
    return true;
  }

  const activeDx = allDiagnoses.filter((d) => wasActiveAt(d, eventAt));

  // Dedupe recent labs by test_name, keeping the freshest value per name.
  // labRows are ordered desc by created_at, so the first occurrence wins.
  // SQL already filters by event-time upper bound and lab window (#514);
  // the retraction and future-lab checks remain as in-memory backstops.
  //
  // The `unit` field (#856) is forwarded as-is so rules can perform
  // unit-aware threshold comparisons. Rows missing a unit degrade to an
  // empty string with a structured warn — unit-aware helpers then treat
  // the lab as unknown rather than silently comparing wrong-unit values.
  const seenLabs = new Set<string>();
  const recentLabs: Array<{ name: string; value: number; unit: string }> = [];
  for (const row of recentLabRows) {
    if (isLabRetracted(row)) continue;
    if (isoBefore(eventAt, row.created_at)) continue;
    if (seenLabs.has(row.test_name)) continue;
    const unit = (row.unit ?? "").trim();
    if (unit === "") {
      logger.warn("lab_result_unit_missing", {
        metric: "lab_result_unit_missing",
        patient_id_prefix: patientId.slice(0, 8),
        test_name: row.test_name,
        caller: "review-service:buildPatientContextForRules",
      });
    }
    seenLabs.add(row.test_name);
    recentLabs.push({ name: row.test_name, value: row.value, unit });
  }

  // A medication was "active at event time" if it had started (started_at
  // present and <= event time) and had not yet ended (ended_at null or
  // strictly after event time). Falls back to created_at when started_at
  // is missing (warn-and-include; #516).
  const activeMedsList = allMeds.filter((m) => {
    if (isMedicationRetracted(m)) return false;
    const start = m.started_at ?? m.created_at;
    if (!m.started_at) {
      logger.warn("medication_started_at_null_fallback", {
        metric: "medication_started_at_null_fallback",
        patient_id_prefix: patientId.slice(0, 8),
        medication_name: m.name,
        created_at_used: m.created_at,
        caller: "review-service:buildPatientContextForRules",
      });
    }
    if (isoBefore(eventAt, start)) return false;
    if (m.ended_at && isoLTE(m.ended_at, eventAt)) return false;
    return true;
  });

  // An allergy is relevant iff it was already recorded before the event
  // AND has not been logically retracted (entered_in_error / refuted —
  // charting corrections that must not drive rule decisions). See #515.
  const patientAllergies = allAllergies.filter((a) => {
    if (isoBefore(eventAt, a.created_at)) return false;
    if (isAllergyRetracted(a)) return false;
    return true;
  });

  return {
    active_diagnoses: activeDx.map((d) => d.description),
    active_diagnosis_codes: activeDx.map((d) => d.icd10_code ?? ""),
    // Structured diagnosis detail with recency metadata (issue #215).
    // Enables rules like ONCO-VTE-NEURO-001 to suppress stale/resolved VTE
    // false positives without losing the flat `active_diagnoses` shape that
    // other rules rely on.
    active_diagnoses_detail: activeDx.map((d) => ({
      description: d.description,
      icd10_code: d.icd10_code ?? null,
      status: d.status ?? null,
      onset_date: d.onset_date ?? null,
      resolved_date: d.resolved_date ?? null,
    })),
    active_medications: activeMedsList.map((m) => m.name),
    active_medication_rxnorm_codes: activeMedsList.map((m) => m.rxnorm_code),
    new_symptoms: newSymptoms,
    care_team_specialties: [], // Not needed for current rules, but available for future
    allergies: patientAllergies.map((a) => ({
      id: a.id,
      allergen: a.allergen,
      rxnorm_code: a.rxnorm_code,
      severity: a.severity,
      reaction: a.reaction,
    })),
    resolved_overrides: overrideRows.map((o) => ({
      allergy_id: o.allergy_id ?? null,
      // Recover allergen + medication strings from the overridden flag's
      // summary. We parse loosely (empty values are fine) so the fallback
      // matcher in `checkAllergyMedication` can still match on allergen
      // alone when the override references an allergy_id.
      allergen: extractAllergenFromFlagSummary(o.flag_summary),
      medication: extractMedicationFromFlagSummary(o.flag_summary),
      override_reason: o.override_reason,
      overridden_at: o.overridden_at,
    })),
    trigger_event: event,
    recent_labs: recentLabs.length > 0 ? recentLabs : undefined,
    event_timestamp: eventAt,
  };
}

/**
 * Extract the medication name from an allergy-medication flag's summary.
 *
 * The canonical summary formats from `checkAllergyMedication` are:
 *   "Medication \"<med>\" matches patient allergy to \"<allergen>\""
 *   "Medication \"<med>\" may cross-react with allergy to \"<allergen>\" ..."
 *
 * Returns null on parse failure so the rule-layer suppression falls back
 * to allergen-only matching rather than throwing.
 */
function extractMedicationFromFlagSummary(
  summary: string | null | undefined,
): string | null {
  if (!summary) return null;
  const m = summary.match(/^Medication "([^"]+)"/);
  return m ? m[1]! : null;
}

/**
 * Extract the allergen name from an allergy-medication flag's summary.
 * See `extractMedicationFromFlagSummary` for the expected format.
 */
function extractAllergenFromFlagSummary(
  summary: string | null | undefined,
): string | null {
  if (!summary) return null;
  const m = summary.match(/allergy to "([^"]+)"/);
  return m ? m[1]! : null;
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
 * Consolidate the rule-flag array produced by the deterministic-rules step
 * before it is persisted and fed to the LLM-dedup check. Applies narrow,
 * clinically-motivated suppressions for flag pairs that describe the same
 * underlying signal.
 *
 * Current policy (issue #854):
 *   - If both `CRITICAL-LAB-POTASSIUM` and `CROSS-QT-HYPOK-001` fire in the
 *     same pass, drop `CRITICAL-LAB-POTASSIUM`. The cross-specialty flag is
 *     strictly more actionable because it names the QT-prolonging drug, and
 *     both flags point clinicians at the same physiologic concern (severe
 *     hypokalemia → torsades / arrhythmia risk). Severity on the surviving
 *     flag is preserved as-is — CROSS-QT-HYPOK-001 already escalates to
 *     `critical` when K+ < 3.0 (see cross-specialty.ts), so no info is lost.
 *
 * Safety posture:
 *   - The dedup is keyed on rule_id pairs — no generic severity/category
 *     suppression. This is deliberate: under-alerting on a critical lab is
 *     far worse than minor UI duplication.
 *   - When QT-HYPOK does NOT fire, CRITICAL-LAB-POTASSIUM passes through
 *     unchanged (including hyperkalemia which never co-fires with QT-HYPOK).
 *   - Unrelated flags in the same batch are untouched.
 *   - Input is not mutated.
 *
 * Exported for unit testing.
 */
export function consolidateRuleFlags(flags: readonly RuleFlag[]): RuleFlag[] {
  const hasQtHypoK = flags.some((f) => f.rule_id === "CROSS-QT-HYPOK-001");
  if (!hasQtHypoK) {
    // No dedup needed — shallow-copy so the caller cannot assume identity
    // with the input reference.
    return [...flags];
  }
  return flags.filter((f) => f.rule_id !== "CRITICAL-LAB-POTASSIUM");
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
