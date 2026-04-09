import { eq, desc, inArray, and } from "drizzle-orm";
import {
  getDb,
  clinicalNotes,
  noteVersions,
  noteAssertions,
  users,
} from "@carebridge/db-schema";
import type { CreateNoteInput, UpdateNoteInput } from "@carebridge/validators";
import type {
  ClinicalNote,
  NoteVersion,
  NoteTimelineEntry,
  NoteAssertionsPayload,
  NoteTemplateType,
} from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Creates a new clinical note, persists it, and emits a "note.saved" event.
 */
export async function createNote(input: CreateNoteInput): Promise<ClinicalNote> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const note: typeof clinicalNotes.$inferInsert = {
    id,
    patient_id: input.patient_id,
    provider_id: input.provider_id,
    encounter_id: input.encounter_id ?? null,
    template_type: input.template_type,
    sections: input.sections,
    version: 1,
    status: "draft",
    created_at: now,
  };

  await db.insert(clinicalNotes).values(note);

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "note.saved",
    patient_id: input.patient_id,
    provider_id: input.provider_id,
    timestamp: now,
    data: { resourceId: id },
  });

  return {
    id,
    patient_id: input.patient_id,
    provider_id: input.provider_id,
    encounter_id: input.encounter_id,
    template_type: input.template_type,
    sections: input.sections,
    version: 1,
    status: "draft",
    created_at: now,
  };
}

/**
 * Updates a note's sections, increments the version, and archives the
 * previous version in the note_versions table.
 */
export async function updateNote(
  noteId: string,
  input: UpdateNoteInput,
): Promise<ClinicalNote> {
  const db = getDb();
  const now = new Date().toISOString();

  // Fetch the current note
  const [existing] = await db
    .select()
    .from(clinicalNotes)
    .where(eq(clinicalNotes.id, noteId))
    .limit(1);

  if (!existing) {
    throw new Error(`Note ${noteId} not found`);
  }

  // Archive the current version
  await db.insert(noteVersions).values({
    id: crypto.randomUUID(),
    note_id: noteId,
    version: existing.version,
    sections: existing.sections,
    saved_at: now,
    saved_by: existing.provider_id,
  });

  const newVersion = existing.version + 1;

  // Update the note with new sections and incremented version
  await db
    .update(clinicalNotes)
    .set({
      sections: input.sections,
      version: newVersion,
    })
    .where(eq(clinicalNotes.id, noteId));

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "note.saved",
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: { resourceId: noteId, version: newVersion },
  });

  return {
    id: noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    encounter_id: existing.encounter_id ?? undefined,
    template_type: existing.template_type as ClinicalNote["template_type"],
    sections: input.sections,
    version: newVersion,
    status: existing.status as ClinicalNote["status"],
    created_at: existing.created_at,
  };
}

/**
 * Signs a clinical note, setting its status to "signed" with signer info.
 */
export async function signNote(
  noteId: string,
  signedBy: string,
): Promise<ClinicalNote> {
  const db = getDb();
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(clinicalNotes)
    .where(eq(clinicalNotes.id, noteId))
    .limit(1);

  if (!existing) {
    throw new Error(`Note ${noteId} not found`);
  }

  await db
    .update(clinicalNotes)
    .set({
      status: "signed",
      signed_at: now,
      signed_by: signedBy,
    })
    .where(eq(clinicalNotes.id, noteId));

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "note.signed",
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: { resourceId: noteId, signedBy },
  });

  return {
    id: noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    encounter_id: existing.encounter_id ?? undefined,
    template_type: existing.template_type as ClinicalNote["template_type"],
    sections: existing.sections as ClinicalNote["sections"],
    version: existing.version,
    status: "signed",
    signed_at: now,
    signed_by: signedBy,
    created_at: existing.created_at,
  };
}

/**
 * Retrieves all notes for a patient, ordered by creation date descending.
 */
export async function getNotesByPatient(patientId: string): Promise<ClinicalNote[]> {
  const db = getDb();

  const rows = await db
    .select()
    .from(clinicalNotes)
    .where(eq(clinicalNotes.patient_id, patientId))
    .orderBy(desc(clinicalNotes.created_at));

  return rows.map((row) => ({
    id: row.id,
    patient_id: row.patient_id,
    provider_id: row.provider_id,
    encounter_id: row.encounter_id ?? undefined,
    template_type: row.template_type as ClinicalNote["template_type"],
    sections: row.sections as ClinicalNote["sections"],
    version: row.version,
    status: row.status as ClinicalNote["status"],
    signed_at: row.signed_at ?? undefined,
    signed_by: row.signed_by ?? undefined,
    cosigned_at: row.cosigned_at ?? undefined,
    cosigned_by: row.cosigned_by ?? undefined,
    copy_forward_score: row.copy_forward_score ?? undefined,
    source_system: row.source_system ?? undefined,
    created_at: row.created_at,
  }));
}

/**
 * Phase C2 — cross-team note timeline.
 *
 * Returns a lean projection of every note for a patient, joined with
 * provider name/specialty from the `users` table and a short preview
 * built from the most recent successful Phase A1 assertion extraction.
 *
 * Sort order: newest first, using signed_at when present (so signed
 * notes sort by clinical time of record) and created_at as a fallback
 * for drafts.
 *
 * This does NOT decrypt the full `sections` column — the clinician
 * portal's timeline tab renders from this projection and only the
 * detail view fetches the full note. Keeps round-trips cheap.
 */
export async function getTimelineByPatient(
  patientId: string,
): Promise<NoteTimelineEntry[]> {
  const db = getDb();

  const noteRows = await db
    .select({
      id: clinicalNotes.id,
      patient_id: clinicalNotes.patient_id,
      provider_id: clinicalNotes.provider_id,
      template_type: clinicalNotes.template_type,
      status: clinicalNotes.status,
      version: clinicalNotes.version,
      signed_at: clinicalNotes.signed_at,
      cosigned_at: clinicalNotes.cosigned_at,
      created_at: clinicalNotes.created_at,
      copy_forward_score: clinicalNotes.copy_forward_score,
    })
    .from(clinicalNotes)
    .where(eq(clinicalNotes.patient_id, patientId))
    .orderBy(desc(clinicalNotes.created_at));

  if (noteRows.length === 0) return [];

  const providerIds = Array.from(
    new Set(noteRows.map((n) => n.provider_id).filter(Boolean)),
  );
  const noteIds = noteRows.map((n) => n.id);

  const [providerRows, assertionRows] = await Promise.all([
    providerIds.length > 0
      ? db
          .select({
            id: users.id,
            name: users.name,
            specialty: users.specialty,
          })
          .from(users)
          .where(inArray(users.id, providerIds))
      : Promise.resolve([] as { id: string; name: string; specialty: string | null }[]),
    db
      .select({
        note_id: noteAssertions.note_id,
        payload: noteAssertions.payload,
        created_at: noteAssertions.created_at,
      })
      .from(noteAssertions)
      .where(
        and(
          inArray(noteAssertions.note_id, noteIds),
          eq(noteAssertions.extraction_status, "success"),
        ),
      )
      .orderBy(desc(noteAssertions.created_at)),
  ]);

  const providerById = new Map<
    string,
    { name: string; specialty: string | null }
  >();
  for (const row of providerRows) {
    providerById.set(row.id, { name: row.name, specialty: row.specialty });
  }

  // Keep only the freshest assertion row per note (rows are sorted desc).
  const assertionByNoteId = new Map<string, NoteAssertionsPayload>();
  for (const row of assertionRows) {
    if (!assertionByNoteId.has(row.note_id)) {
      assertionByNoteId.set(row.note_id, row.payload as NoteAssertionsPayload);
    }
  }

  const entries: NoteTimelineEntry[] = noteRows.map((row) => {
    const provider = providerById.get(row.provider_id) ?? null;
    const payload = assertionByNoteId.get(row.id) ?? null;

    let assertion_preview: NoteTimelineEntry["assertion_preview"] = null;
    if (payload) {
      assertion_preview = {
        one_line_summary: payload.one_line_summary ?? "",
        assessment_problems: (payload.assessments ?? [])
          .slice(0, 3)
          .map((a) => a.problem),
        top_plan_actions: (payload.plan_items ?? [])
          .slice(0, 3)
          .map((p) => p.action),
      };
    }

    return {
      id: row.id,
      patient_id: row.patient_id,
      provider_id: row.provider_id,
      provider_name: provider?.name ?? null,
      provider_specialty: provider?.specialty ?? null,
      template_type: row.template_type as NoteTemplateType,
      status: row.status as NoteTimelineEntry["status"],
      version: row.version,
      signed_at: row.signed_at ?? null,
      cosigned_at: row.cosigned_at ?? null,
      created_at: row.created_at,
      copy_forward_score: row.copy_forward_score ?? null,
      assertion_preview,
    };
  });

  // Secondary sort: newest signed_at wins among rows with identical
  // created_at buckets. Drafts without signed_at fall back to created_at.
  entries.sort((a, b) => {
    const aKey = a.signed_at ?? a.created_at;
    const bKey = b.signed_at ?? b.created_at;
    return bKey.localeCompare(aKey);
  });

  return entries;
}

/**
 * Retrieves a single note by ID along with its version history.
 */
export async function getNoteById(
  noteId: string,
): Promise<{ note: ClinicalNote; versions: NoteVersion[] } | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(clinicalNotes)
    .where(eq(clinicalNotes.id, noteId))
    .limit(1);

  if (!row) return null;

  const versions = await db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.note_id, noteId))
    .orderBy(desc(noteVersions.version));

  return {
    note: {
      id: row.id,
      patient_id: row.patient_id,
      provider_id: row.provider_id,
      encounter_id: row.encounter_id ?? undefined,
      template_type: row.template_type as ClinicalNote["template_type"],
      sections: row.sections as ClinicalNote["sections"],
      version: row.version,
      status: row.status as ClinicalNote["status"],
      signed_at: row.signed_at ?? undefined,
      signed_by: row.signed_by ?? undefined,
      cosigned_at: row.cosigned_at ?? undefined,
      cosigned_by: row.cosigned_by ?? undefined,
      copy_forward_score: row.copy_forward_score ?? undefined,
      source_system: row.source_system ?? undefined,
      created_at: row.created_at,
    },
    versions: versions.map((v) => ({
      note_id: v.note_id,
      version: v.version,
      sections: v.sections as NoteVersion["sections"],
      saved_at: v.saved_at,
      saved_by: v.saved_by,
    })),
  };
}
