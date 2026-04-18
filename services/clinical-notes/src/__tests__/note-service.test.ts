import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateReturningMock = vi.fn();
const updateSetWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
const updateSetMock = vi.fn(() => ({ where: updateSetWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const selectOrderByMock = vi.fn();
const selectFromWhereLimitMock = vi.fn();
const selectFromWhereMock = vi.fn(() => ({
  limit: selectFromWhereLimitMock,
  orderBy: selectOrderByMock,
}));
const selectFromMock = vi.fn(() => ({
  where: selectFromWhereMock,
  orderBy: selectOrderByMock,
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
    update: updateMock,
  }),
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
  getNotesByPatient,
  getNoteById,
  NoteConflictError,
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
  // Reset chaining defaults
  selectOrderByMock.mockReturnValue({ where: selectFromWhereMock });
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

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const insertedValues = insertValuesMock.mock.calls[0][0];
    expect(insertedValues.patient_id).toBe(PATIENT_ID);
    expect(insertedValues.version).toBe(1);
    expect(insertedValues.status).toBe("draft");
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
    const inserted = insertValuesMock;
    await createNote({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      template_type: "soap",
      sections: soapSections,
    });

    const insertedValues = inserted.mock.calls[0][0];
    expect(insertedValues.encounter_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// updateNote
// ─────────────────────────────────────────────────────────────────
describe("updateNote", () => {
  it("increments version and returns updated sections", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, { sections: updatedSections });

    expect(result.version).toBe(4);
    expect(result.sections).toEqual(updatedSections);
  });

  it("archives the old version in note_versions", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    await updateNote(NOTE_ID, { sections: updatedSections });

    // First insert call is the archive, second is from the note-service insert
    // Actually: insert is called once for archive, then update is used for the note
    expect(insertMock).toHaveBeenCalledTimes(1);
    const archivedValues = insertValuesMock.mock.calls[0][0];
    expect(archivedValues.note_id).toBe(NOTE_ID);
    expect(archivedValues.version).toBe(3);
    expect(archivedValues.sections).toEqual(existingRow.sections);
  });

  it("emits a note.saved event with the new version", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    await updateNote(NOTE_ID, { sections: updatedSections });

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.saved");
    expect(event.data.version).toBe(4);
    expect(event.data.resourceId).toBe(NOTE_ID);
  });

  it("succeeds when expectedVersion matches the current version", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, {
      sections: updatedSections,
      expectedVersion: 3,
    });

    expect(result.version).toBe(4);
  });

  it("throws NoteConflictError when expectedVersion does not match", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([]);

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
    selectFromWhereLimitMock.mockResolvedValueOnce([]);

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
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);

    const result = await signNote(NOTE_ID, PROVIDER_ID);

    expect(result.status).toBe("signed");
    expect(result.signed_by).toBe(PROVIDER_ID);
    expect(result.signed_at).toBeDefined();
    expect(typeof result.signed_at).toBe("string");
  });

  it("calls db.update to persist the signed status", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);

    await signNote(NOTE_ID, PROVIDER_ID);

    expect(updateMock).toHaveBeenCalled();
    const setArg = updateSetMock.mock.calls[0][0];
    expect(setArg.status).toBe("signed");
    expect(setArg.signed_by).toBe(PROVIDER_ID);
    expect(setArg.signed_at).toBeDefined();
  });

  it("emits a note.signed clinical event", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);

    await signNote(NOTE_ID, PROVIDER_ID);

    expect(emitClinicalEvent).toHaveBeenCalledTimes(1);
    const event = emitClinicalEvent.mock.calls[0][0];
    expect(event.type).toBe("note.signed");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.data.signedBy).toBe(PROVIDER_ID);
    expect(event.data.resourceId).toBe(NOTE_ID);
  });

  it("throws when note is not found", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([]);

    await expect(signNote("nonexistent", PROVIDER_ID)).rejects.toThrow(
      "Note nonexistent not found",
    );
  });

  it("preserves the existing version number", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);

    const result = await signNote(NOTE_ID, PROVIDER_ID);

    expect(result.version).toBe(existingRow.version);
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
    selectOrderByMock.mockResolvedValueOnce(rows);

    const result = await getNotesByPatient(PATIENT_ID);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("aaa");
    expect(result[1].id).toBe("bbb");
  });

  it("returns empty array when patient has no notes", async () => {
    selectOrderByMock.mockResolvedValueOnce([]);

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
    selectOrderByMock.mockResolvedValueOnce([row]);

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
    // First select().from().where().limit() returns the note
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    // Second select().from().where().orderBy() returns versions
    selectOrderByMock.mockResolvedValueOnce([
      {
        note_id: NOTE_ID,
        version: 2,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "v2" }],
        saved_at: "2026-03-14T10:00:00.000Z",
        saved_by: PROVIDER_ID,
      },
      {
        note_id: NOTE_ID,
        version: 1,
        sections: [{ key: "s", label: "Subjective", fields: [], free_text: "v1" }],
        saved_at: "2026-03-13T10:00:00.000Z",
        saved_by: PROVIDER_ID,
      },
    ]);

    const result = await getNoteById(NOTE_ID);

    expect(result).not.toBeNull();
    expect(result!.note.id).toBe(NOTE_ID);
    expect(result!.note.version).toBe(3);
    expect(result!.versions).toHaveLength(2);
    expect(result!.versions[0].version).toBe(2);
    expect(result!.versions[1].version).toBe(1);
  });

  it("returns null when note is not found", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([]);

    const result = await getNoteById("nonexistent");

    expect(result).toBeNull();
  });

  it("returns empty versions array for a note with no history", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    selectOrderByMock.mockResolvedValueOnce([]);

    const result = await getNoteById(NOTE_ID);

    expect(result).not.toBeNull();
    expect(result!.versions).toEqual([]);
  });

  it("maps nullable fields to undefined on the note", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    selectOrderByMock.mockResolvedValueOnce([]);

    const result = await getNoteById(NOTE_ID);

    expect(result!.note.encounter_id).toBeUndefined();
    expect(result!.note.signed_at).toBeUndefined();
    expect(result!.note.signed_by).toBeUndefined();
  });
});
