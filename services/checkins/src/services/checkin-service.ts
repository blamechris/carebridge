/**
 * Phase B1 — check-in submission service.
 *
 * Submits a patient check-in and fires `checkin.submitted` onto the
 * clinical-events queue so the ai-oversight worker can evaluate
 * Phase B4 red-flag rules against the responses + full patient
 * clinical context.
 *
 * Responsibilities:
 *   1. Load and validate the template — must be published, not
 *      retired, and the client-supplied version must still match.
 *      Writing a stale version is a hard error so the UI is forced
 *      to re-render against the current template.
 *   2. Sanitise any free-text answers through the PHI sanitiser so
 *      note-level prompt-injection defences also cover patient-voice
 *      inputs.
 *   3. Compute red-flag hits deterministically on the server so the
 *      client cannot suppress or invent them.
 *   4. Insert the check-in row (encrypted responses).
 *   5. Emit a `checkin.submitted` ClinicalEvent carrying the minimum
 *      the review worker needs — no raw responses — so PHI never
 *      rides on the event payload.
 *
 * All failures bubble to the caller as plain Errors; the tRPC router
 * translates them into user-facing codes.
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  checkIns,
  checkInTemplates,
} from "@carebridge/db-schema";
import {
  checkInQuestionSchema,
  type CheckInQuestion,
  type CheckInResponses,
  type CheckInRelationship,
} from "@carebridge/validators";
import { sanitizeFreeText } from "@carebridge/phi-sanitizer";
import { emitClinicalEvent } from "../events.js";
import { evaluateRedFlagHits } from "./redflag-evaluator.js";

export interface SubmitCheckInParams {
  patient_id: string;
  template_id: string;
  template_version: number;
  responses: CheckInResponses;
  submitted_by_user_id: string;
  submitted_by_relationship: CheckInRelationship;
}

export interface SubmittedCheckIn {
  id: string;
  patient_id: string;
  template_id: string;
  template_version: number;
  template_slug: string;
  target_condition: string;
  submitted_by_user_id: string;
  submitted_by_relationship: CheckInRelationship;
  red_flag_hits: string[];
  submitted_at: string;
}

/**
 * Error subclasses so the router can map to tRPC error codes without
 * string matching.
 */
export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Check-in template ${templateId} not found`);
    this.name = "TemplateNotFoundError";
  }
}

export class TemplateRetiredError extends Error {
  constructor(templateId: string) {
    super(`Check-in template ${templateId} is retired`);
    this.name = "TemplateRetiredError";
  }
}

export class TemplateVersionMismatchError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly clientVersion: number,
    public readonly serverVersion: number,
  ) {
    super(
      `Template ${templateId} version mismatch: client sent v${clientVersion}, server is v${serverVersion}`,
    );
    this.name = "TemplateVersionMismatchError";
  }
}

/**
 * Recursively walk an answer value and scrub any embedded PHI via the
 * same sanitiser used for clinician note bodies. Only strings are
 * touched; booleans, numbers, and nested arrays of strings pass
 * through untouched in their non-string slots.
 */
function sanitizeResponses(raw: CheckInResponses): CheckInResponses {
  const out: CheckInResponses = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = sanitizeFreeText(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) =>
        typeof v === "string" ? sanitizeFreeText(v) : v,
      ) as string[];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Parse the template's JSON-encoded `questions` column into a typed
 * array. Stored as JSON text (not JSONB) so the column survives the
 * Drizzle encrypted-column helpers; validated on read so a corrupt
 * row surfaces immediately instead of slipping into red-flag
 * evaluation.
 */
function parseQuestions(rawJson: string): CheckInQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `Check-in template has malformed questions JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Check-in template questions must be an array");
  }
  return parsed.map((q, idx) => {
    const result = checkInQuestionSchema.safeParse(q);
    if (!result.success) {
      throw new Error(
        `Check-in template question at index ${idx} failed validation: ${result.error.message}`,
      );
    }
    return result.data;
  });
}

/**
 * Submit a check-in. See the module header for the full pipeline.
 *
 * Returns a minimal summary (never the responses) so audit logs and
 * downstream code can reason about the submission without
 * re-decrypting the encrypted column.
 */
export async function submitCheckIn(
  params: SubmitCheckInParams,
): Promise<SubmittedCheckIn> {
  const db = getDb();

  // 1. Load template.
  const [template] = await db
    .select()
    .from(checkInTemplates)
    .where(eq(checkInTemplates.id, params.template_id))
    .limit(1);

  if (!template) {
    throw new TemplateNotFoundError(params.template_id);
  }
  if (template.retired_at) {
    throw new TemplateRetiredError(params.template_id);
  }
  if (!template.published_at) {
    throw new TemplateRetiredError(params.template_id);
  }
  if (template.version !== params.template_version) {
    throw new TemplateVersionMismatchError(
      params.template_id,
      params.template_version,
      template.version,
    );
  }

  const questions = parseQuestions(template.questions);

  // 2. Sanitise free-text responses.
  const cleanedResponses = sanitizeResponses(params.responses);

  // 3. Compute red-flag hits on the sanitised responses. We pass the
  //    cleaned values so the red-flag evaluator and downstream rules
  //    see the same content that's stored on disk.
  const redFlagHits = evaluateRedFlagHits(questions, cleanedResponses);

  const now = new Date().toISOString();
  const checkInId = crypto.randomUUID();

  // 4. Insert the row. Responses column is encrypted at rest by the
  //    encryptedJsonb helper in the schema.
  await db.insert(checkIns).values({
    id: checkInId,
    patient_id: params.patient_id,
    template_id: params.template_id,
    template_version: template.version,
    submitted_by_user_id: params.submitted_by_user_id,
    submitted_by_relationship: params.submitted_by_relationship,
    responses: cleanedResponses,
    red_flag_hits: JSON.stringify(redFlagHits),
    submitted_at: now,
    created_at: now,
  });

  // 5. Emit the clinical event. Payload is intentionally minimal —
  //    only the fields the review worker needs to decide whether to
  //    run red-flag rules. The worker will load the full check-in
  //    row itself (inside its own PHI-handling boundary) when it
  //    needs the responses.
  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "checkin.submitted",
    patient_id: params.patient_id,
    timestamp: now,
    data: {
      resourceId: checkInId,
      template_slug: template.slug,
      template_version: template.version,
      target_condition: template.target_condition,
      red_flag_count: redFlagHits.length,
      red_flag_hits: redFlagHits,
      submitted_by_relationship: params.submitted_by_relationship,
    },
  });

  return {
    id: checkInId,
    patient_id: params.patient_id,
    template_id: params.template_id,
    template_version: template.version,
    template_slug: template.slug,
    target_condition: template.target_condition,
    submitted_by_user_id: params.submitted_by_user_id,
    submitted_by_relationship: params.submitted_by_relationship,
    red_flag_hits: redFlagHits,
    submitted_at: now,
  };
}
