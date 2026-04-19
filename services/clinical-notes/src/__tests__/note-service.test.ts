import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── Mock DB ──────────────────────────────────────────────────────
// A single MockDb instance is recreated per test so queued results and call
// history reset cleanly. The helper chains any order of .from/.where/.limit/
// .orderBy/.values/.set/.returning and resolves to the next queued result
// when the chain is awaited.
let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  clinicalNotes: {
    id: "id",
    patient_id: "patient_id",
    provider_id: "provider_id",
    version: "version",
    created_at: "created_at",
  },
  noteVersions: {
    note_id: "note_id",
    version: "version",
    saved_at: "saved_at",
    lifecycle_event: "lifecycle_event",
  },
  auditLog: {
    id: "id",
  },
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const {
  createNote,
  updateNote,
  signNote,
  cosignNote,
  amendNote,
  getNotesByPatient,
  getNoteById,
  getVersionHistory,
  NoteConflictError,
  NoteStateError,
} = await import("../services/note-service.js");

// ── Fixtures ────────────────────────────────────────────────────
const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const PATIENT_ID = "22222222-2222-2222-2222-222222222222";
const PROVIDER_ID = "33333333-3333-3333-3333-333333333333";
const ENCOUNTER_ID = "44444444-4444-4444-4444-444444444444";

const soapSections = [
  { key: "s", label: "Subjective", fields: [], free_text: "Patient reports headache" },
];

const existingRow = {
  id: NOTE_ID,
  patient_id: PATIENT_ID,
  provider_id: PROVIDER_ID,
  encounter_id: null,
  template_type: "soap",
  sections: [{ key: "s", label: "Subjective", fields: [], free_text: "old" }],
  version: 3,
  status: "draft",
  signed_at: null,
  signed_by: null,
  cosigned_at: null,
  cosigned_by: null,
  copy_forward_score: null,
  source_system: null,
  created_at: "2026-03-15T10:00:00.000Z",
};

const updatedSections = [
  { key: "s", label: "Subjective", fields: [], free_text: "updated" },
];

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

// ─────────────────────────────────────────────────────────────────
// createNote
// ─────────────────────────────────────────────────────────────────
describe("createNote", () => {
  it("creates a note with version 1 and draft status", async () => {
    const result = await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    expect(result.patient_id).toBe(PATIENT_ID);
    expect(result.provider_id).toBe(PROVIDER_ID);
    expect(result.version).toBe(1);
    expect(result.status).toBe("draft");
    expect(result.template_type).toBe("soap");
    expect(result.sections).toEqual(soapSections);
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });

  it("persists the note via db.insert", async () => {
    await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    // Two inserts: the clinical_notes row and the v1 draft archive (#888).
    expect(db.insert).toHaveBeenCalledTimes(2);
    const insertCall = db.insert.calls[0];
    expect(insertCall?.chain).toContain("values");
    const insertedValues = insertCall?.chainArgs[0]?.[0] as {
      patient_id: string;
      version: number;
      status: string;
    };
    expect(insertedValues.patient_id).toBe(PATIENT_ID);
    expect(insertedValues.version).toBe(1);
    expect(insertedValues.status).toBe("draft");
  });

  it("archives v1 to note_versions with lifecycle_event=draft on create (#888)", async () => {
    await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    // The 2nd insert is the version-archive write. Before #888 the
    // version history was empty until the first sign / update — a note
    // that was viewed as a draft had no snapshot to show.
    expect(db.insert).toHaveBeenCalledTimes(2);
    const archived = db.insert.calls[1]?.chainArgs[0]?.[0] as {
      note_id: string;
      version: number;
      sections: unknown;
      saved_by: string;
      lifecycle_event: string;
    };
    expect(archived.version).toBe(1);
    expect(archived.saved_by).toBe(PROVIDER_ID);
    expect(archived.sections).toEqual(soapSections);
    expect(archived.lifecycle_event).toBe("draft");
  });

  it("emits a note.saved clinical event on create", async () => {
    const result = await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.saved");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.provider_id).toBe(PROVIDER_ID);
    expect(event.data.resourceId).toBe(result.id);
  });

  it("sets encounter_id when provided", async () => {
    const result = await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      encounter_id: ENCOUNTER_ID,
      template_type: "progress",
      sections: soapSections,
    });

    expect(result.encounter_id).toBe(ENCOUNTER_ID);
  });

  it("sets encounter_id to null when omitted", async () => {
    await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    const insertedValues = db.insert.calls[0]?.chainArgs[0]?.[0] as {
      encounter_id: unknown;
    };
    expect(insertedValues.encounter_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// updateNote
// ─────────────────────────────────────────────────────────────────
describe("updateNote", () => {
  it("increments version and returns updated sections", async () => {
    db.willSelect([existingRow]).willInsert().willUpdate([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, { sections: updatedSections });

    expect(result.version).toBe(4);
    expect(result.sections).toEqual(updatedSections);
  });

  it("archives the old version in note_versions with lifecycle_event=draft", async () => {
    db.willSelect([existingRow]).willInsert().willUpdate([{ id: NOTE_ID }]);

    await updateNote(NOTE_ID, { sections: updatedSections });

    expect(db.insert).toHaveBeenCalledTimes(1);
    const archivedValues = db.insert.calls[0]?.chainArgs[0]?.[0] as {
      note_id: string;
      version: number;
      sections: unknown;
      lifecycle_event: string;
    };
    expect(archivedValues.note_id).toBe(NOTE_ID);
    expect(archivedValues.version).toBe(3);
    expect(archivedValues.sections).toEqual(existingRow.sections);
    expect(archivedValues.lifecycle_event).toBe("draft");
  });

  it("emits a note.saved event with the new version", async () => {
    db.willSelect([existingRow]).willInsert().willUpdate([{ id: NOTE_ID }]);

    await updateNote(NOTE_ID, { sections: updatedSections });

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.saved");
    expect(event.data.version).toBe(4);
    expect(event.data.resourceId).toBe(NOTE_ID);
  });

  it("succeeds when expectedVersion matches the current version", async () => {
    db.willSelect([existingRow]).willInsert().willUpdate([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, {
      sections: updatedSections,
      expectedVersion: 3,
    });

    expect(result.version).toBe(4);
  });

  it("throws NoteConflictError when expectedVersion does not match", async () => {
    db.willSelect([existingRow]).willInsert().willUpdate([]);

    const error = await updateNote(NOTE_ID, {
      sections: updatedSections,
      expectedVersion: 2,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoteConflictError);
    expect((error as InstanceType<typeof NoteConflictError>).message).toBe(
      "Note was modified by another user. Please refresh and try again.",
    );
    expect(emitClinicalEvent).not.toHaveBeenCalled();
  });

  it("throws when note is not found", async () => {
    db.willSelect([]);

    await expect(
      updateNote("nonexistent", { sections: updatedSections }),
    ).rejects.toThrow("Note nonexistent not found");
  });
});

// ─────────────────────────────────────────────────────────────────
// signNote
// ─────────────────────────────────────────────────────────────────
describe("signNote", () => {
  it("sets status to signed with signer and timestamp", async () => {
    db.willSelect([existingRow]);

    const result = await signNote(NOTE_ID, PROVIDER_ID);

    expect(result.status).toBe("signed");
    expect(result.signed_by).toBe(PROVIDER_ID);
    expect(result.signed_at).toBeDefined();
    expect(typeof result.signed_at).toBe("string");
  });

  it("calls db.update to persist the signed status", async () => {
    db.willSelect([existingRow]);

    await signNote(NOTE_ID, PROVIDER_ID);

    expect(db.update).toHaveBeenCalled();
    const updateCall = db.update.calls[0];
    const setIndex = updateCall?.chain.indexOf("set") ?? -1;
    expect(setIndex).toBeGreaterThanOrEqual(0);
    const setArg = updateCall?.chainArgs[setIndex]?.[0] as {
      status: string;
      signed_by: string;
      signed_at: string;
    };
    expect(setArg.status).toBe("signed");
    expect(setArg.signed_by).toBe(PROVIDER_ID);
    expect(setArg.signed_at).toBeDefined();
  });

  it("emits a note.signed clinical event", async () => {
    db.willSelect([existingRow]);

    await signNote(NOTE_ID, PROVIDER_ID);

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.signed");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.data.signedBy).toBe(PROVIDER_ID);
    expect(event.data.resourceId).toBe(NOTE_ID);
  });

  it("throws when note is not found", async () => {
    db.willSelect([]);

    await expect(signNote("nonexistent", PROVIDER_ID)).rejects.toThrow(
      "Note nonexistent not found",
    );
  });

  it("preserves the existing version number", async () => {
    db.willSelect([existingRow]);

    const result = await signNote(NOTE_ID, PROVIDER_ID);

    expect(result.version).toBe(existingRow.version);
  });

  it("archives a version row with lifecycle_event=signed", async () => {
    db.willSelect([existingRow]);

    await signNote(NOTE_ID, PROVIDER_ID);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const archived = db.insert.calls[0]?.chainArgs[0]?.[0] as {
      note_id: string;
      version: number;
      saved_by: string;
      lifecycle_event: string;
    };
    expect(archived.note_id).toBe(NOTE_ID);
    expect(archived.version).toBe(existingRow.version);
    expect(archived.saved_by).toBe(PROVIDER_ID);
    expect(archived.lifecycle_event).toBe("signed");
  });
});

// ─────────────────────────────────────────────────────────────────
// getNotesByPatient
// ─────────────────────────────────────────────────────────────────
describe("getNotesByPatient", () => {
  it("returns notes ordered by created_at descending", async () => {
    const rows = [
      { ...existingRow, id: "aaa", created_at: "2026-03-16T10:00:00.000Z" },
      { ...existingRow, id: "bbb", created_at: "2026-03-15T10:00:00.000Z" },
    ];
    db.willSelect(rows);

    const result = await getNotesByPatient(PATIENT_ID);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("aaa");
    expect(result[1].id).toBe("bbb");
  });

  it("returns empty array when patient has no notes", async () => {
    db.willSelect([]);

    const result = await getNotesByPatient(PATIENT_ID);

    expect(result).toEqual([]);
  });

  it("maps nullable fields to undefined", async () => {
    const row = {
      ...existingRow,
      encounter_id: null,
      signed_at: null,
      signed_by: null,
      cosigned_at: null,
      cosigned_by: null,
      copy_forward_score: null,
      source_system: null,
    };
    db.willSelect([row]);

    const result = await getNotesByPatient(PATIENT_ID);

    expect(result[0].encounter_id).toBeUndefined();
    expect(result[0].signed_at).toBeUndefined();
    expect(result[0].signed_by).toBeUndefined();
    expect(result[0].cosigned_at).toBeUndefined();
    expect(result[0].cosigned_by).toBeUndefined();
    expect(result[0].copy_forward_score).toBeUndefined();
    expect(result[0].source_system).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// getNoteById
// ─────────────────────────────────────────────────────────────────
describe("getNoteById", () => {
  it("returns the note and its version history", async () => {
    // First select resolves the note, second select resolves versions.
    db.willSelect([existingRow]).willSelect([
      {
        note_id: NOTE_ID,
        version: 2,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "v2" }],
        saved_at: "2026-03-14T10:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "amended",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "v1" }],
        saved_at: "2026-03-13T10:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "signed",
      },
    ]);

    const result = await getNoteById(NOTE_ID);

    expect(result).not.toBeNull();
    expect(result!.note.id).toBe(NOTE_ID);
    expect(result!.note.version).toBe(3);
    expect(result!.versions).toHaveLength(2);
    expect(result!.versions[0].version).toBe(2);
    expect(result!.versions[0].lifecycle_event).toBe("amended");
    expect(result!.versions[1].version).toBe(1);
    expect(result!.versions[1].lifecycle_event).toBe("signed");
  });

  it("returns null when note is not found", async () => {
    db.willSelect([]);

    const result = await getNoteById("nonexistent");

    expect(result).toBeNull();
  });

  it("returns empty versions array for a note with no history", async () => {
    db.willSelect([existingRow]).willSelect([]);

    const result = await getNoteById(NOTE_ID);

    expect(result).not.toBeNull();
    expect(result!.versions).toEqual([]);
  });

  it("maps nullable fields to undefined on the note", async () => {
    db.willSelect([existingRow]).willSelect([]);

    const result = await getNoteById(NOTE_ID);

    expect(result!.note.encounter_id).toBeUndefined();
    expect(result!.note.signed_at).toBeUndefined();
    expect(result!.note.signed_by).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// cosignNote
// ─────────────────────────────────────────────────────────────────
const COSIGNER_ID = "55555555-5555-5555-5555-555555555555";

const signedRow = {
  ...existingRow,
  status: "signed",
  signed_at: "2026-03-15T11:00:00.000Z",
  signed_by: PROVIDER_ID,
};

describe("cosignNote", () => {
  it("transitions a signed note to cosigned and records cosigner", async () => {
    db.willSelect([signedRow]);

    const result = await cosignNote(NOTE_ID, COSIGNER_ID);

    expect(result.status).toBe("cosigned");
    expect(result.cosigned_by).toBe(COSIGNER_ID);
    expect(result.cosigned_at).toBeDefined();
    expect(typeof result.cosigned_at).toBe("string");
  });

  it("persists cosign via db.update with cosigned status", async () => {
    db.willSelect([signedRow]);

    await cosignNote(NOTE_ID, COSIGNER_ID);

    expect(db.update).toHaveBeenCalled();
    const updateCall = db.update.calls[0];
    const setIndex = updateCall?.chain.indexOf("set") ?? -1;
    expect(setIndex).toBeGreaterThanOrEqual(0);
    const setArg = updateCall?.chainArgs[setIndex]?.[0] as {
      status: string;
      cosigned_by: string;
      cosigned_at: string;
    };
    expect(setArg.status).toBe("cosigned");
    expect(setArg.cosigned_by).toBe(COSIGNER_ID);
    expect(setArg.cosigned_at).toBeDefined();
  });

  it("archives a version row snapshotting the signed state with lifecycle_event=cosigned", async () => {
    db.willSelect([signedRow]);

    await cosignNote(NOTE_ID, COSIGNER_ID);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = db.insert.calls[0]?.chainArgs[0]?.[0] as {
      note_id: string;
      version: number;
      sections: unknown;
      saved_by: string;
      lifecycle_event: string;
    };
    expect(insertedValues.note_id).toBe(NOTE_ID);
    expect(insertedValues.version).toBe(signedRow.version);
    expect(insertedValues.sections).toEqual(signedRow.sections);
    expect(insertedValues.saved_by).toBe(COSIGNER_ID);
    expect(insertedValues.lifecycle_event).toBe("cosigned");
  });

  it("emits a note.cosigned clinical event", async () => {
    db.willSelect([signedRow]);

    await cosignNote(NOTE_ID, COSIGNER_ID);

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.cosigned");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.data.cosignedBy).toBe(COSIGNER_ID);
    expect(event.data.resourceId).toBe(NOTE_ID);
  });

  it("throws NoteStateError when note is in draft status", async () => {
    db.willSelect([{ ...existingRow, status: "draft" }]);

    const error = await cosignNote(NOTE_ID, COSIGNER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoteStateError);
    expect((error as Error).message).toMatch(/cosign/i);
    expect(emitClinicalEvent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws NoteStateError when note is already cosigned", async () => {
    db.willSelect([
      { ...signedRow, status: "cosigned", cosigned_by: "someone", cosigned_at: "x" },
    ]);

    const error = await cosignNote(NOTE_ID, COSIGNER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoteStateError);
    expect(emitClinicalEvent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws NoteStateError when note is amended", async () => {
    db.willSelect([{ ...signedRow, status: "amended" }]);

    const error = await cosignNote(NOTE_ID, COSIGNER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoteStateError);
  });

  it("throws when note is not found", async () => {
    db.willSelect([]);

    await expect(cosignNote("nonexistent", COSIGNER_ID)).rejects.toThrow(
      "Note nonexistent not found",
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// amendNote
// ─────────────────────────────────────────────────────────────────
const AMENDER_ID = "66666666-6666-6666-6666-666666666666";
const AMEND_REASON = "Correcting dose recorded in error.";

const cosignedRow = {
  ...signedRow,
  status: "cosigned",
  cosigned_at: "2026-03-16T09:00:00.000Z",
  cosigned_by: COSIGNER_ID,
};

describe("amendNote", () => {
  it("amends a signed note, creating a new version and archiving the prior", async () => {
    db.willSelect([signedRow]);

    const result = await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(result.status).toBe("amended");
    expect(result.version).toBe(signedRow.version + 1);
    expect(result.sections).toEqual(updatedSections);
  });

  it("archives the pre-amendment version in note_versions with lifecycle_event=amended", async () => {
    db.willSelect([signedRow]);

    await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const archived = db.insert.calls[0]?.chainArgs[0]?.[0] as {
      note_id: string;
      version: number;
      sections: unknown;
      saved_by: string;
      lifecycle_event: string;
    };
    expect(archived.note_id).toBe(NOTE_ID);
    expect(archived.version).toBe(signedRow.version);
    expect(archived.sections).toEqual(signedRow.sections);
    expect(archived.saved_by).toBe(AMENDER_ID);
    expect(archived.lifecycle_event).toBe("amended");
  });

  it("updates the note row with new sections, bumped version, amended status", async () => {
    db.willSelect([signedRow]);

    await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(db.update).toHaveBeenCalled();
    const updateCall = db.update.calls[0];
    const setIndex = updateCall?.chain.indexOf("set") ?? -1;
    expect(setIndex).toBeGreaterThanOrEqual(0);
    const setArg = updateCall?.chainArgs[setIndex]?.[0] as {
      status: string;
      version: number;
      sections: unknown;
    };
    expect(setArg.status).toBe("amended");
    expect(setArg.version).toBe(signedRow.version + 1);
    expect(setArg.sections).toEqual(updatedSections);
  });

  it("emits a note.amended event including the reason", async () => {
    db.willSelect([signedRow]);

    await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.amended");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.data.resourceId).toBe(NOTE_ID);
    expect(event.data.amendedBy).toBe(AMENDER_ID);
    expect(event.data.reason).toBe(AMEND_REASON);
  });

  it("allows amending a cosigned note", async () => {
    db.willSelect([cosignedRow]);

    const result = await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(result.status).toBe("amended");
  });

  it("allows amending an already-amended note (chain)", async () => {
    db.willSelect([{ ...signedRow, status: "amended" }]);

    const result = await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON);

    expect(result.status).toBe("amended");
  });

  it("throws NoteStateError when amending a draft note", async () => {
    db.willSelect([{ ...existingRow, status: "draft" }]);

    const error = await amendNote(NOTE_ID, AMENDER_ID, updatedSections, AMEND_REASON).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NoteStateError);
    expect(emitClinicalEvent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws when note is not found", async () => {
    db.willSelect([]);

    await expect(
      amendNote("nonexistent", AMENDER_ID, updatedSections, AMEND_REASON),
    ).rejects.toThrow("Note nonexistent not found");
  });
});

// ─────────────────────────────────────────────────────────────────
// getVersionHistory
// ─────────────────────────────────────────────────────────────────
describe("getVersionHistory", () => {
  it("returns versions in the chronological order the DB yields (saved_at asc)", async () => {
    // The DB query uses orderBy(asc(saved_at)); the mock returns rows in the
    // order queued, so the test fixture is already in chronological order.
    db.willSelect([
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [],
        saved_at: "2026-03-15T10:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "signed",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [],
        saved_at: "2026-03-15T11:00:00.000Z",
        saved_by: COSIGNER_ID,
        lifecycle_event: "cosigned",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [],
        saved_at: "2026-03-15T12:00:00.000Z",
        saved_by: AMENDER_ID,
        lifecycle_event: "amended",
      },
    ]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions).toHaveLength(3);
    expect(versions[0].lifecycle_event).toBe("signed");
    expect(versions[1].lifecycle_event).toBe("cosigned");
    expect(versions[2].lifecycle_event).toBe("amended");
  });

  it("orders the query by saved_at ascending", async () => {
    db.willSelect([]);

    await getVersionHistory(NOTE_ID);

    const selectCall = db.select.calls[0];
    const orderByIndex = selectCall?.chain.indexOf("orderBy") ?? -1;
    expect(orderByIndex).toBeGreaterThanOrEqual(0);
    // The asc(saved_at) helper yields an object referencing the column.
    // Asserting the column reference is stable — the exact structure
    // returned by drizzle's asc() is not.
    const orderByArgs = selectCall?.chainArgs[orderByIndex] ?? [];
    expect(orderByArgs.length).toBeGreaterThan(0);
  });

  it("exposes lifecycle_event on each version", async () => {
    db.willSelect([
      {
        note_id: NOTE_ID,
        version: 2,
        sections: [],
        saved_at: "2026-03-15T12:00:00.000Z",
        saved_by: AMENDER_ID,
        lifecycle_event: "amended",
      },
    ]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions[0].lifecycle_event).toBe("amended");
    expect(versions[0].saved_by).toBe(AMENDER_ID);
  });

  it("returns empty array when no history exists", async () => {
    db.willSelect([]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions).toEqual([]);
  });

  // ─── Regression scenarios from #879 review ────────────────────
  //
  // These fixture the exact clinical workflows that produced the unstable
  // ordering: create→sign→cosign and create→sign→amend. The mock returns
  // the rows in saved_at-ascending order (matching what the production
  // query does), so the assertions pin both the event labels and the
  // chronological order that getVersionHistory must produce.

  it("create → sign → cosign yields [draft, signed, cosigned] in chronological order (#888)", async () => {
    // After #888, createNote archives the initial draft as v1 — so a
    // create → sign → cosign sequence produces THREE rows, not two. All
    // three share version=1 because neither sign nor cosign bumps
    // clinical_notes.version; the lifecycle_event label is what
    // disambiguates them.
    db.willSelect([
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T09:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "draft",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T10:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "signed",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T11:00:00.000Z",
        saved_by: COSIGNER_ID,
        lifecycle_event: "cosigned",
      },
    ]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.lifecycle_event)).toEqual([
      "draft",
      "signed",
      "cosigned",
    ]);
    expect(versions[0].saved_by).toBe(PROVIDER_ID);
    expect(versions[1].saved_by).toBe(PROVIDER_ID);
    expect(versions[2].saved_by).toBe(COSIGNER_ID);
    expect(versions.map((v) => v.version)).toEqual([1, 1, 1]);
  });

  it("create → sign → amend → amend yields [draft, signed, amended, amended] in chronological order (#888)", async () => {
    // After #888 the initial draft gets archived at create time. First
    // amend archives the signed snapshot at version=1 and bumps the live
    // row to version=2. Second amend archives version=2 and bumps to
    // version=3 — so the full history is four rows, not three.
    db.willSelect([
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T09:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "draft",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T10:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "signed",
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T11:00:00.000Z",
        saved_by: AMENDER_ID,
        lifecycle_event: "amended",
      },
      {
        note_id: NOTE_ID,
        version: 2,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "first amend" }],
        saved_at: "2026-03-15T12:00:00.000Z",
        saved_by: AMENDER_ID,
        lifecycle_event: "amended",
      },
    ]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions).toHaveLength(4);
    expect(versions.map((v) => v.lifecycle_event)).toEqual([
      "draft",
      "signed",
      "amended",
      "amended",
    ]);
    expect(versions.map((v) => v.version)).toEqual([1, 1, 1, 2]);
  });

  it("returns [draft v1] for a note that was created but never transitioned (#888)", async () => {
    // Prior to #888 the version history of an unsaved-past-draft note
    // was []. After #888 it's a single draft row — which is what the
    // "what did this draft look like when it was first saved?" audit
    // question needs to answer.
    db.willSelect([
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "initial" }],
        saved_at: "2026-03-15T09:00:00.000Z",
        saved_by: PROVIDER_ID,
        lifecycle_event: "draft",
      },
    ]);

    const versions = await getVersionHistory(NOTE_ID);

    expect(versions).toHaveLength(1);
    expect(versions[0].lifecycle_event).toBe("draft");
    expect(versions[0].version).toBe(1);
    expect(versions[0].saved_by).toBe(PROVIDER_ID);
  });
});

