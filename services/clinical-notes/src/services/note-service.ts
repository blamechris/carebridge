import { eq, and, asc, desc } from "drizzle-orm";
import { getDb, clinicalNotes, noteVersions } from "@carebridge/db-schema";
import type { CreateNoteInput, UpdateNoteInput } from "@carebridge/validators";
import type {
  ClinicalNote,
  NoteLifecycleEvent,
  NoteSection,
  NoteVersion,
} from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Thrown when an optimistic locking conflict is detected (concurrent modification).
 */
export class NoteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteConflictError";
  }
}

/**
 * Thrown when an operation is attempted on a note in an incompatible state —
 * e.g. cosigning a draft note, or amending a note that has not been signed.
 */
export class NoteStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteStateError";
  }
}

/**
 * Archive a note's current sections as an immutable `note_versions` row.
 *
 * Version rows are the append-only audit spine for clinical notes; every
 * state-changing operation (sign, cosign, amend) writes one before mutating
 * the live `clinical_notes` row so history can be reconstructed even if
 * later edits overwrite the current sections. The `note_versions` table has
 * no UPDATE path at the application layer — rows are insert-only.
 *
 * `lifecycleEvent` labels which transition caused the archive. This is
 * required to disambiguate rows that share the same `version` number:
 * signNote and cosignNote both archive at `existing.version` without
 * bumping it, so without the label `getVersionHistory` could not tell
 * a signed snapshot apart from the cosigned one that follows it.
 */
async function archiveVersion(params: {
  noteId: string;
  version: number;
  sections: unknown;
  savedBy: string;
  savedAt: string;
  lifecycleEvent: NoteLifecycleEvent;
}): Promise<void> {
  const db = getDb();
  await db.insert(noteVersions).values({
    id: crypto.randomUUID(),
    note_id: params.noteId,
    version: params.version,
    sections: params.sections,
    saved_at: params.savedAt,
    saved_by: params.savedBy,
    lifecycle_event: params.lifecycleEvent,
  });
}

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

  // Archive the current version. updateNote is the draft-edit path — the
  // archived snapshot represents the pre-edit draft state.
  await archiveVersion({
    noteId,
    version: existing.version,
    sections: existing.sections,
    savedBy: existing.provider_id,
    savedAt: now,
    lifecycleEvent: "draft",
  });

  const newVersion = existing.version + 1;

  // Optimistic locking: when expectedVersion is provided, only update if the
  // row hasn't been modified since the caller last read it.
  const whereClause = input.expectedVersion
    ? and(eq(clinicalNotes.id, noteId), eq(clinicalNotes.version, input.expectedVersion))
    : eq(clinicalNotes.id, noteId);

  // Update the note with new sections and incremented version
  const result = await db
    .update(clinicalNotes)
    .set({
      sections: input.sections,
      version: newVersion,
    })
    .where(whereClause)
    .returning({ id: clinicalNotes.id });

  if (result.length === 0 && input.expectedVersion) {
    throw new NoteConflictError(
      "Note was modified by another user. Please refresh and try again.",
    );
  }

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
 *
 * Archives the current sections into `note_versions` before the state
 * change so the signed-at-time snapshot is preserved even if the note is
 * later amended.
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

  await archiveVersion({
    noteId,
    version: existing.version,
    sections: existing.sections,
    savedBy: signedBy,
    savedAt: now,
    lifecycleEvent: "signed",
  });

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
 * Cosign a signed clinical note.
 *
 * Only notes in status `signed` can be cosigned. Draft notes must be
 * signed first; already-cosigned or amended notes are rejected to keep
 * cosign a single-party, idempotent transition (multi-party cosign chains
 * are explicitly out of scope per #398). Records the cosigner identity,
 * archives the signed-time sections as an immutable version row, and
 * advances status to `cosigned`.
 */
export async function cosignNote(
  noteId: string,
  cosignedBy: string,
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

  if (existing.status !== "signed") {
    throw new NoteStateError(
      `Cannot cosign note in status "${existing.status}": cosign requires status "signed"`,
    );
  }

  await archiveVersion({
    noteId,
    version: existing.version,
    sections: existing.sections,
    savedBy: cosignedBy,
    savedAt: now,
    lifecycleEvent: "cosigned",
  });

  await db
    .update(clinicalNotes)
    .set({
      status: "cosigned",
      cosigned_at: now,
      cosigned_by: cosignedBy,
    })
    .where(eq(clinicalNotes.id, noteId));

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "note.cosigned",
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: { resourceId: noteId, cosignedBy },
  });

  return {
    id: noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    encounter_id: existing.encounter_id ?? undefined,
    template_type: existing.template_type as ClinicalNote["template_type"],
    sections: existing.sections as ClinicalNote["sections"],
    version: existing.version,
    status: "cosigned",
    signed_at: existing.signed_at ?? undefined,
    signed_by: existing.signed_by ?? undefined,
    cosigned_at: now,
    cosigned_by: cosignedBy,
    created_at: existing.created_at,
  };
}

/**
 * Amend a signed, cosigned, or previously amended clinical note.
 *
 * Amendments are the only way to change the content of a note after it
 * has been signed — direct edits (`updateNote`) are restricted to drafts.
 * The pre-amendment sections are archived to `note_versions` under the
 * current version number, then the live row is updated with the new
 * sections and an incremented version. Status transitions to `amended`
 * regardless of the prior state (signed → amended, cosigned → amended,
 * amended → amended). A non-empty `reason` is required and is recorded
 * in the emitted clinical event for downstream audit propagation.
 */
export async function amendNote(
  noteId: string,
  amendedBy: string,
  sections: NoteSection[],
  reason: string,
): Promise<ClinicalNote> {
  if (!reason || reason.trim().length === 0) {
    throw new Error("Amendment reason is required");
  }

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

  if (existing.status === "draft") {
    throw new NoteStateError(
      "Cannot amend a draft note; use updateNote on drafts and sign before amending",
    );
  }

  await archiveVersion({
    noteId,
    version: existing.version,
    sections: existing.sections,
    savedBy: amendedBy,
    savedAt: now,
    lifecycleEvent: "amended",
  });

  const newVersion = existing.version + 1;

  await db
    .update(clinicalNotes)
    .set({
      status: "amended",
      sections,
      version: newVersion,
    })
    .where(eq(clinicalNotes.id, noteId));

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "note.amended",
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    timestamp: now,
    data: {
      resourceId: noteId,
      amendedBy,
      reason: reason.trim(),
      previousVersion: existing.version,
      newVersion,
    },
  });

  return {
    id: noteId,
    patient_id: existing.patient_id,
    provider_id: existing.provider_id,
    encounter_id: existing.encounter_id ?? undefined,
    template_type: existing.template_type as ClinicalNote["template_type"],
    sections,
    version: newVersion,
    status: "amended",
    signed_at: existing.signed_at ?? undefined,
    signed_by: existing.signed_by ?? undefined,
    cosigned_at: existing.cosigned_at ?? undefined,
    cosigned_by: existing.cosigned_by ?? undefined,
    created_at: existing.created_at,
  };
}

/**
 * Fetch every version row for a note, ordered chronologically by
 * `saved_at`. `getNoteById` returns the same data in descending order for UI
 * "latest first" displays; this helper is the canonical chronological view
 * used for audit timelines.
 *
 * Ordering by `saved_at` (not `version`) is deliberate: signNote and
 * cosignNote archive at the same `existing.version` without bumping it, so
 * a `version`-only sort is unstable across sign/cosign pairs. `saved_at` is
 * the monotonic source of truth for transition order; the `version` column
 * remains meaningful for identifying amendment-boundary snapshots.
 */
export async function getVersionHistory(noteId: string): Promise<NoteVersion[]> {
  const db = getDb();

  const rows = await db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.note_id, noteId))
    .orderBy(asc(noteVersions.saved_at));

  return rows.map((v) => ({
    note_id: v.note_id,
    version: v.version,
    sections: v.sections as NoteVersion["sections"],
    saved_at: v.saved_at,
    saved_by: v.saved_by,
    lifecycle_event: v.lifecycle_event as NoteVersion["lifecycle_event"],
  }));
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
      lifecycle_event: v.lifecycle_event as NoteVersion["lifecycle_event"],
    })),
  };
}
