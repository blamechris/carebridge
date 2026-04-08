/**
 * Phase A1: note extractor.
 *
 * Turns a signed clinical note into a typed {@link NoteAssertionsPayload}
 * and persists it to `note_assertions`. Runs as a side-effect of
 * `note.signed` events dispatched by the review pipeline — it must never
 * break note signing or block rule-based flagging.
 *
 * Pipeline (mirrors review-service for consistency):
 *   1. Load the source note from the DB (decrypts sections transparently)
 *   2. Render sections as plain text for the LLM
 *   3. Redact PHI via the same redactClinicalText() pipeline used by
 *      clinical review — uses the patient's name / MRN / age for
 *      substitution
 *   4. assertPromptSanitized() fail-closed gate (throws before any
 *      network call if redaction missed anything)
 *   5. Kill-switch gate via assertLLMEnabled() — throws LLMDisabledError
 *   6. Claude call via reviewPatientRecord() (reuses retry + timeout)
 *   7. Parse the JSON response into NoteAssertionsPayload
 *   8. Persist a row to note_assertions with status + error + timing
 *
 * Failure handling: every failure mode lands as its own extraction_status:
 *   - "llm_disabled"         — kill-switch engaged; persists empty payload
 *   - "sanitization_failed"  — PHI leaked into the prompt; persists empty
 *                              payload; logs the category but NOT the text
 *   - "llm_failed"           — Claude API or network error; persists empty
 *   - "parse_failed"         — Claude returned non-JSON or wrong shape
 *   - "success"              — payload persisted
 *
 * A failed extraction row is still inserted so downstream consumers and
 * monitoring can observe failures without scraping logs.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  clinicalNotes,
  noteAssertions,
  patients,
} from "@carebridge/db-schema";
import {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_SYSTEM_PROMPT,
  buildNoteExtractionPrompt,
  parseNoteExtractionResponse,
  renderNoteBodyForExtraction,
  EMPTY_NOTE_ASSERTIONS,
} from "@carebridge/ai-prompts";
import {
  assertPromptSanitized,
  redactClinicalText,
  SanitizationError,
} from "@carebridge/phi-sanitizer";
import type {
  NoteAssertionsPayload,
  NoteExtractionStatus,
  NoteSection,
} from "@carebridge/shared-types";
import {
  LLMDisabledError,
  isLLMEnabled,
  reviewPatientRecord,
} from "../services/claude-client.js";

const MODEL_ID = "claude-sonnet-4-6";

/**
 * Minimal surface of `reviewPatientRecord` the extractor needs. Typed as
 * an injectable parameter so tests can substitute a stub without touching
 * `process.env.ANTHROPIC_API_KEY` or the Anthropic SDK.
 */
export type LLMCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

export interface ExtractNoteArgs {
  noteId: string;
  /**
   * Optional LLM caller override. Defaults to `reviewPatientRecord` from
   * claude-client. Tests pass a stub.
   */
  llmCaller?: LLMCaller;
}

export interface ExtractNoteResult {
  id: string;
  note_id: string;
  status: NoteExtractionStatus;
  payload: NoteAssertionsPayload;
  error: string | null;
  processing_time_ms: number;
}

/**
 * Extract assertions from a signed note and persist the result.
 *
 * Idempotency: NOT currently idempotent by design. Re-running this for
 * the same note_id inserts another row. The caller is responsible for
 * only dispatching once per `note.signed` event; BullMQ's at-most-once
 * delivery semantics apply.
 */
export async function extractNote(
  args: ExtractNoteArgs,
): Promise<ExtractNoteResult> {
  const started = Date.now();
  const db = getDb();
  const llmCall = args.llmCaller ?? reviewPatientRecord;

  // Step 1: load the note. If it doesn't exist we cannot proceed.
  const note = await db.query.clinicalNotes.findFirst({
    where: eq(clinicalNotes.id, args.noteId),
  });
  if (!note) {
    throw new Error(`note-extractor: note ${args.noteId} not found`);
  }

  // Step 2: render the note body for the LLM. `sections` is decrypted
  // by the Drizzle custom type on read — we handle it as NoteSection[].
  const sections = (note.sections as unknown as NoteSection[]) ?? [];
  const renderedBody = renderNoteBodyForExtraction(sections);

  // Step 3: redact PHI. Reuses the same pipeline as review-service so
  // the note extractor cannot drift into a weaker PHI posture.
  const patientRow = await db.query.patients.findFirst({
    where: eq(patients.id, note.patient_id),
  });
  const redaction = redactClinicalText(renderedBody, {
    patientName: patientRow?.name ?? undefined,
    facilityNames: [],
    referenceDate: new Date(),
  });

  // Step 4: build the user message and run the fail-closed sanitization
  // gate. If residual PHI is found, persist the failure with category
  // metadata but NO free-text so logs stay clean.
  const userMessage = buildNoteExtractionPrompt({
    template_type: note.template_type,
    note_body: redaction.redactedText,
  });

  try {
    assertPromptSanitized(userMessage);
  } catch (err) {
    if (err instanceof SanitizationError) {
      return persist(db, {
        note_id: note.id,
        patient_id: note.patient_id,
        status: "sanitization_failed",
        error: `PHI detected in extraction prompt: ${err.violations.join(", ")}`,
        payload: EMPTY_NOTE_ASSERTIONS,
        processing_time_ms: Date.now() - started,
      });
    }
    throw err;
  }

  // Step 5: kill-switch gate. Persist an explicit llm_disabled row so
  // ops can tell "extraction was skipped because LLM is off" apart from
  // "extraction failed to parse".
  if (!isLLMEnabled()) {
    return persist(db, {
      note_id: note.id,
      patient_id: note.patient_id,
      status: "llm_disabled",
      error: "LLM review disabled at extraction time (kill-switch engaged)",
      payload: EMPTY_NOTE_ASSERTIONS,
      processing_time_ms: Date.now() - started,
    });
  }

  // Step 6: call Claude. The LLMDisabledError path below handles the
  // race where the kill-switch flips between Step 5 and the API call.
  let rawResponse: string;
  try {
    rawResponse = await llmCall(NOTE_EXTRACTION_SYSTEM_PROMPT, userMessage);
  } catch (err) {
    if (err instanceof LLMDisabledError) {
      return persist(db, {
        note_id: note.id,
        patient_id: note.patient_id,
        status: "llm_disabled",
        error: err.reason,
        payload: EMPTY_NOTE_ASSERTIONS,
        processing_time_ms: Date.now() - started,
      });
    }
    return persist(db, {
      note_id: note.id,
      patient_id: note.patient_id,
      status: "llm_failed",
      error: err instanceof Error ? err.message : String(err),
      payload: EMPTY_NOTE_ASSERTIONS,
      processing_time_ms: Date.now() - started,
    });
  }

  // Step 7: parse. A parse failure is observable but not fatal.
  const parseResult = parseNoteExtractionResponse(rawResponse);
  if (!parseResult.ok) {
    return persist(db, {
      note_id: note.id,
      patient_id: note.patient_id,
      status: "parse_failed",
      error: parseResult.reason,
      payload: EMPTY_NOTE_ASSERTIONS,
      processing_time_ms: Date.now() - started,
    });
  }

  // Step 8: success — persist the extracted payload.
  return persist(db, {
    note_id: note.id,
    patient_id: note.patient_id,
    status: "success",
    error: null,
    payload: parseResult.payload,
    processing_time_ms: Date.now() - started,
  });
}

interface PersistArgs {
  note_id: string;
  patient_id: string;
  status: NoteExtractionStatus;
  error: string | null;
  payload: NoteAssertionsPayload;
  processing_time_ms: number;
}

async function persist(
  db: ReturnType<typeof getDb>,
  args: PersistArgs,
): Promise<ExtractNoteResult> {
  const id = crypto.randomUUID();
  const row = {
    id,
    note_id: args.note_id,
    patient_id: args.patient_id,
    payload: args.payload,
    extraction_status: args.status,
    error: args.error,
    model_id: MODEL_ID,
    prompt_version: NOTE_EXTRACTION_PROMPT_VERSION,
    processing_time_ms: args.processing_time_ms,
    created_at: new Date().toISOString(),
  };
  await db.insert(noteAssertions).values(row);
  return {
    id,
    note_id: args.note_id,
    status: args.status,
    payload: args.payload,
    error: args.error,
    processing_time_ms: args.processing_time_ms,
  };
}
