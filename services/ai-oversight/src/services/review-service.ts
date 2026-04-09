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

import { eq, desc, gte, lte, and } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  reviewJobs,
  diagnoses,
  medications,
  patients,
  labPanels,
  labResults,
  clinicalNotes,
  noteAssertions,
  users,
  vitals,
  checkIns,
  checkInTemplates,
} from "@carebridge/db-schema";
import type {
  ClinicalEvent,
  FlagSource,
  NoteAssertionsPayload,
} from "@carebridge/shared-types";
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
import {
  checkNoteCorrelation,
  type NoteCorrelationContext,
} from "../rules/note-correlation.js";
import {
  checkCheckInRedFlags,
  type CheckInRuleContext,
  type PriorCheckInSummary,
} from "../rules/checkin-redflags.js";
import { buildPatientContext } from "../workers/context-builder.js";
import { isLLMEnabled, reviewPatientRecord, LLMDisabledError } from "./claude-client.js";
import { createFlag } from "./flag-service.js";
import { extractNote } from "../extractors/note-extractor.js";
import {
  routeFlagsToCareTeam,
  type FlagRoutingPayload,
} from "./notification-router.js";
import { hasActiveAiConsent } from "./consent-service.js";

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
    // Phase C3: every flag we create here gets fan-out routed to the
    // relevant care-team members at job completion. Collecting payloads
    // lets us batch the routing into a single DB round-trip per job.
    const flagRoutingPayloads: FlagRoutingPayload[] = [];

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
      flagRoutingPayloads.push({
        flag_id: flag.id,
        patient_id: event.patient_id,
        severity: ruleFlag.severity,
        category: ruleFlag.category,
        summary: ruleFlag.summary,
        notify_specialties: ruleFlag.notify_specialties,
        rule_id: ruleFlag.rule_id,
      });
    }

    // Step 3b: Phase A1 note extraction + Phase A2 note-correlation rules.
    // Fires on note.signed only. Runs as a non-blocking side-effect:
    // extractor or correlation failures must NOT break the review job.
    // The extractor has its own kill-switch gate, PHI sanitization, and
    // failure-row persistence, so errors there are already observable
    // from the note_assertions table.
    if (event.type === "note.signed") {
      const noteId = event.data.resourceId;
      if (typeof noteId === "string" && noteId.length > 0) {
        try {
          const extraction = await extractNote({ noteId });
          console.log(
            `[review-service] Note extraction for ${noteId}: status=${extraction.status} ` +
              `(${extraction.processing_time_ms}ms)`,
          );

          // Phase A2: only run correlation rules when the extraction
          // succeeded. For failed extractions there's nothing to reason
          // about — the failure mode is captured in note_assertions
          // and has its own visibility path.
          if (extraction.status === "success") {
            try {
              const correlationCtx = await buildNoteCorrelationContext(
                noteId,
                extraction.payload,
              );
              if (correlationCtx) {
                rulesEvaluated.push("note-correlation");
                const correlationFlags = checkNoteCorrelation(correlationCtx);
                if (correlationFlags.length > 0) {
                  rulesFired.push("note-correlation");
                  for (const ruleFlag of correlationFlags) {
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
                    allRuleFlags.push(ruleFlag);
                    flagRoutingPayloads.push({
                      flag_id: flag.id,
                      patient_id: event.patient_id,
                      severity: ruleFlag.severity,
                      category: ruleFlag.category,
                      summary: ruleFlag.summary,
                      notify_specialties: ruleFlag.notify_specialties,
                      rule_id: ruleFlag.rule_id,
                    });
                  }
                  console.log(
                    `[review-service] Note correlation for ${noteId}: ` +
                      `${correlationFlags.length} flag(s) created`,
                  );
                }
              }
            } catch (correlationErr) {
              const msg =
                correlationErr instanceof Error
                  ? correlationErr.message
                  : String(correlationErr);
              console.error(
                `[review-service] Note correlation failed for ${noteId}: ${msg}`,
              );
              // Swallow — extraction is valuable even without correlation.
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[review-service] Note extraction failed for ${noteId}: ${msg}`,
          );
          // Swallow — the review job continues regardless.
        }
      }
    }

    // Step 3c: Phase B4 check-in red-flag rules. Fires on
    // checkin.submitted only. Runs as a non-blocking side effect: a
    // rule evaluation failure here must NOT demote the job to failed —
    // the check-in row still exists and patient-voice data is not
    // lost. We reload the check-in row from the DB rather than
    // trusting the event payload to carry responses, because the
    // event payload is intentionally PHI-free (see Phase B1 service
    // docs) and because defence-in-depth against a stale/forged event.
    if (event.type === "checkin.submitted") {
      const checkinId = event.data.resourceId;
      if (typeof checkinId === "string" && checkinId.length > 0) {
        try {
          const checkinCtx = await buildCheckInRuleContext(
            checkinId,
            event.patient_id,
          );
          if (checkinCtx) {
            rulesEvaluated.push("checkin-redflags");
            const checkinFlags = checkCheckInRedFlags(checkinCtx);
            if (checkinFlags.length > 0) {
              rulesFired.push("checkin-redflags");
              for (const ruleFlag of checkinFlags) {
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
                allRuleFlags.push(ruleFlag);
                flagRoutingPayloads.push({
                  flag_id: flag.id,
                  patient_id: event.patient_id,
                  severity: ruleFlag.severity,
                  category: ruleFlag.category,
                  summary: ruleFlag.summary,
                  notify_specialties: ruleFlag.notify_specialties,
                  rule_id: ruleFlag.rule_id,
                });
              }
              console.log(
                `[review-service] Check-in red-flags for ${checkinId}: ` +
                  `${checkinFlags.length} flag(s) created`,
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[review-service] Check-in rule evaluation failed for ${checkinId}: ${msg}`,
          );
          // Swallow — the review job continues regardless.
        }
      }
    }

    // Step 4: LLM review path — gated on the kill-switch. When disabled,
    // deterministic rules still fire above; we just skip the LLM step and
    // mark the job completed. This is the operator's failsafe: disabling
    // LLM review must NEVER break the review pipeline.
    if (!isLLMEnabled()) {
      await safeRouteFlagsToCareTeam(flagRoutingPayloads);
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

    // Step 4b: Patient AI consent gate. The kill-switch is a global ops
    // control; the consent gate is a per-patient opt-in. Both must pass
    // before we send any derived context to Claude. Missing consent
    // degrades gracefully to rules-only — the patient still gets
    // deterministic coverage, they just don't participate in the LLM
    // review path until they explicitly opt in.
    const hasConsent = await hasActiveAiConsent(event.patient_id, "llm_review");
    if (!hasConsent) {
      await safeRouteFlagsToCareTeam(flagRoutingPayloads);
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
        `[review-service] Job ${jobId} completed in ${processingTime}ms (rules-only; no active AI consent for patient ${event.patient_id}). ` +
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
        await safeRouteFlagsToCareTeam(flagRoutingPayloads);
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
      flagRoutingPayloads.push({
        flag_id: flag.id,
        patient_id: event.patient_id,
        severity: finding.severity,
        category: finding.category,
        summary: finding.summary,
        notify_specialties: finding.notify_specialties,
        rule_id: null,
      });
    }

    // Step 8b: Fan out notifications to the care team. Done after all
    // flag inserts so the batch can share DB round-trips; errors here
    // are swallowed — a routing failure must not mark the job failed.
    await safeRouteFlagsToCareTeam(flagRoutingPayloads);

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
 * Dispatch care-team routing without letting routing failures propagate.
 * Notification fan-out is best-effort: a routing error should never
 * demote a successfully-reviewed job to "failed" — the flags already
 * live in clinical_flags and will still surface in the inbox tab on the
 * patient chart.
 */
async function safeRouteFlagsToCareTeam(
  payloads: FlagRoutingPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  try {
    await routeFlagsToCareTeam(payloads);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[review-service] Care-team routing failed: ${msg}`);
  }
}

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
 * Build a NoteCorrelationContext from the database for a newly-signed
 * note. Returns null if the note cannot be loaded or is missing its
 * signed_at timestamp (correlation is meaningless for unsigned drafts).
 *
 * Called from review-service after a successful extraction.
 *
 * Windows:
 *   - prior_notes: last 7 days before signing (inclusive), excluding the
 *     current note and any prior note from the same provider_id.
 *   - recent_vitals: ±24h around signed_at.
 *   - subsequent_panels: 0–14 days after signing (ORDERED-NOT-RESULTED).
 */
export async function buildNoteCorrelationContext(
  noteId: string,
  currentPayload: NoteAssertionsPayload,
): Promise<NoteCorrelationContext | null> {
  const db = getDb();

  const note = await db.query.clinicalNotes.findFirst({
    where: eq(clinicalNotes.id, noteId),
  });
  if (!note || !note.signed_at) return null;

  const signedAtMs = new Date(note.signed_at).getTime();
  if (Number.isNaN(signedAtMs)) return null;

  const LOOKBACK_DAYS = 7;
  const PANEL_WINDOW_DAYS = 14;
  const VITAL_WINDOW_HOURS = 24;

  const lookbackCutoff = new Date(
    signedAtMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const vitalWindowStart = new Date(
    signedAtMs - VITAL_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const vitalWindowEnd = new Date(
    signedAtMs + VITAL_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const panelWindowEnd = new Date(
    signedAtMs + PANEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Kick off the independent DB reads in parallel. The prior-notes path
  // is serial because it needs the current note's metadata first, but
  // everything else is independent.
  const [currentProvider, priorNoteRows, vitalRows, panelRows, activeMedRows] =
    await Promise.all([
      note.provider_id
        ? db.query.users.findFirst({ where: eq(users.id, note.provider_id) })
        : Promise.resolve(null),
      db
        .select()
        .from(clinicalNotes)
        .where(
          and(
            eq(clinicalNotes.patient_id, note.patient_id),
            gte(clinicalNotes.signed_at, lookbackCutoff),
          ),
        )
        .orderBy(desc(clinicalNotes.signed_at)),
      db
        .select()
        .from(vitals)
        .where(
          and(
            eq(vitals.patient_id, note.patient_id),
            gte(vitals.recorded_at, vitalWindowStart),
            lte(vitals.recorded_at, vitalWindowEnd),
          ),
        )
        .orderBy(desc(vitals.recorded_at)),
      db
        .select()
        .from(labPanels)
        .where(
          and(
            eq(labPanels.patient_id, note.patient_id),
            gte(labPanels.created_at, note.signed_at),
            lte(labPanels.created_at, panelWindowEnd),
          ),
        ),
      db
        .select()
        .from(medications)
        .where(
          and(
            eq(medications.patient_id, note.patient_id),
            eq(medications.status, "active"),
          ),
        ),
    ]);

  // For each prior note, fetch the freshest successful assertions row
  // and resolve the prior provider's specialty. Parallelized per-note.
  const priorNotes: NoteCorrelationContext["prior_notes"] = [];
  const priorCandidates = priorNoteRows.filter(
    (n) => n.id !== noteId && n.signed_at !== null,
  );
  const priorResults = await Promise.all(
    priorCandidates.map(async (priorNote) => {
      const [assertionsRows, providerRow] = await Promise.all([
        db
          .select()
          .from(noteAssertions)
          .where(
            and(
              eq(noteAssertions.note_id, priorNote.id),
              eq(noteAssertions.extraction_status, "success"),
            ),
          )
          .orderBy(desc(noteAssertions.created_at))
          .limit(1),
        priorNote.provider_id
          ? db.query.users.findFirst({
              where: eq(users.id, priorNote.provider_id),
            })
          : Promise.resolve(null),
      ]);
      if (assertionsRows.length === 0) return null;
      return {
        id: priorNote.id,
        provider_id: priorNote.provider_id,
        provider_specialty: providerRow?.specialty ?? null,
        signed_at: priorNote.signed_at as string,
        payload: assertionsRows[0].payload as NoteAssertionsPayload,
      };
    }),
  );
  for (const entry of priorResults) {
    if (entry) priorNotes.push(entry);
  }

  return {
    current_note: {
      id: note.id,
      patient_id: note.patient_id,
      provider_id: note.provider_id,
      provider_specialty: currentProvider?.specialty ?? null,
      signed_at: note.signed_at,
      payload: currentPayload,
    },
    prior_notes: priorNotes,
    recent_vitals: vitalRows.map((v) => ({
      type: v.type,
      value_primary: v.value_primary,
      value_secondary: v.value_secondary,
      unit: v.unit,
      recorded_at: v.recorded_at,
    })),
    subsequent_panels: panelRows.map((p) => ({
      panel_name: p.panel_name,
      ordered_at: p.collected_at,
      reported_at: p.reported_at,
      created_at: p.created_at,
    })),
    active_medication_names: activeMedRows.map((m) => m.name),
    now: new Date(),
  };
}

/**
 * Build a CheckInRuleContext from the database for a newly-submitted
 * check-in. Returns null if the check-in or its template can't be
 * loaded.
 *
 * The rule engine is pure — this is where we materialise the one
 * authoritative view of: the current check-in row, its template's
 * metadata (target_condition, slug), recent prior submissions for the
 * streak rule, and the patient's active diagnoses / medications.
 *
 * Windows:
 *   - prior_checkins: last 14 days before the current submission,
 *     max 50 rows. Bounded so the context never blows up for a
 *     hyperactive family caregiver.
 */
export async function buildCheckInRuleContext(
  checkinId: string,
  patientId: string,
): Promise<CheckInRuleContext | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(checkIns)
    .where(eq(checkIns.id, checkinId))
    .limit(1);
  if (!row) return null;

  const [template] = await db
    .select({
      slug: checkInTemplates.slug,
      target_condition: checkInTemplates.target_condition,
    })
    .from(checkInTemplates)
    .where(eq(checkInTemplates.id, row.template_id))
    .limit(1);
  if (!template) return null;

  // Bound prior submissions to the 14-day window ending just before
  // the current submission.
  const PRIOR_WINDOW_DAYS = 14;
  const PRIOR_MAX_ROWS = 50;
  const currentMs = new Date(row.submitted_at).getTime();
  const windowStart = new Date(
    currentMs - PRIOR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [priorRows, activeDx, activeMeds] = await Promise.all([
    db
      .select({
        id: checkIns.id,
        template_id: checkIns.template_id,
        template_version: checkIns.template_version,
        red_flag_hits: checkIns.red_flag_hits,
        submitted_at: checkIns.submitted_at,
      })
      .from(checkIns)
      .where(
        and(
          eq(checkIns.patient_id, patientId),
          gte(checkIns.submitted_at, windowStart),
        ),
      )
      .orderBy(desc(checkIns.submitted_at))
      .limit(PRIOR_MAX_ROWS),
    db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
    db.select().from(medications).where(eq(medications.patient_id, patientId)),
  ]);

  // For each prior row, resolve the template snapshot (slug +
  // target_condition) so rules can key off it. Batched to avoid N+1.
  const priorTemplateIds = Array.from(
    new Set(priorRows.map((r) => r.template_id)),
  );
  const templateById = new Map<
    string,
    { slug: string; target_condition: string }
  >();
  if (priorTemplateIds.length > 0) {
    const templates = await db
      .select({
        id: checkInTemplates.id,
        slug: checkInTemplates.slug,
        target_condition: checkInTemplates.target_condition,
      })
      .from(checkInTemplates);
    for (const t of templates) {
      templateById.set(t.id, {
        slug: t.slug,
        target_condition: t.target_condition,
      });
    }
  }

  const priorCheckins: PriorCheckInSummary[] = [];
  for (const r of priorRows) {
    if (r.id === row.id) continue;
    const tpl = templateById.get(r.template_id);
    if (!tpl) continue;
    priorCheckins.push({
      id: r.id,
      template_slug: tpl.slug,
      template_version: r.template_version,
      target_condition: tpl.target_condition,
      red_flag_hits: safeParseStringArrayColumn(r.red_flag_hits),
      submitted_at: r.submitted_at,
    });
  }

  const activeDxRows = activeDx.filter((d) => d.status === "active");

  return {
    current: {
      id: row.id,
      template_slug: template.slug,
      template_version: row.template_version,
      target_condition: template.target_condition,
      red_flag_hits: safeParseStringArrayColumn(row.red_flag_hits),
      submitted_at: row.submitted_at,
      submitted_by_relationship: row.submitted_by_relationship,
    },
    active_diagnoses: activeDxRows.map((d) => d.description),
    active_diagnosis_codes: activeDxRows.map((d) => d.icd10_code ?? ""),
    active_medications: activeMeds
      .filter((m) => m.status === "active")
      .map((m) => m.name),
    prior_checkins: priorCheckins,
    now: new Date(),
  };
}

/**
 * Parse the `red_flag_hits` JSON text column defensively — a corrupt
 * value should not take the review pipeline down.
 */
function safeParseStringArrayColumn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
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
