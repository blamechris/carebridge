import { eq, desc } from "drizzle-orm";
import { getDb, clinicalNotes, noteVersions } from "@carebridge/db-schema";
import type { CreateNoteInput, UpdateNoteInput } from "@carebridge/validators";
import type { ClinicalNote, NoteVersion } from "@carebridge/shared-types";
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
    type: "note.saved",
    noteId: id,
    patient_id: input.patient_id,
    provider_id: input.provider_id,
    timestamp: now,
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
    type: "note.saved",
    noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: { version: newVersion },
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
    type: "note.signed",
    noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: { signedBy },
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
