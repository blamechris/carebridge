import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateReturningMock = vi.fn();
const updateSetWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
const updateSetMock = vi.fn(() => ({ where: updateSetWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const selectFromWhereLimitMock = vi.fn();
const selectFromWhereMock = vi.fn(() => ({
  limit: selectFromWhereLimitMock,
}));
const selectFromMock = vi.fn(() => ({
  where: selectFromWhereMock,
  orderBy: vi.fn().mockReturnValue({ where: selectFromWhereMock }),
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
  noteVersions: {},
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const { updateNote, NoteConflictError } = await import(
  "../services/note-service.js"
);

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const PATIENT_ID = "22222222-2222-2222-2222-222222222222";
const PROVIDER_ID = "33333333-3333-3333-3333-333333333333";

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
});

describe("updateNote", () => {
  it("updates a note without optimistic locking when expectedVersion is omitted", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, { sections: updatedSections });

    expect(result.version).toBe(4);
    expect(result.sections).toEqual(updatedSections);
    expect(updateSetWhereMock).toHaveBeenCalledOnce();
  });

  it("succeeds when expectedVersion matches the current version", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    updateReturningMock.mockResolvedValueOnce([{ id: NOTE_ID }]);

    const result = await updateNote(NOTE_ID, {
      sections: updatedSections,
      expectedVersion: 3,
    });

    expect(result.version).toBe(4);
    expect(result.sections).toEqual(updatedSections);
  });

  it("throws NoteConflictError when expectedVersion does not match (concurrent modification)", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    // Update returns 0 rows because version doesn't match
    updateReturningMock.mockResolvedValueOnce([]);

    const error = await updateNote(NOTE_ID, {
      sections: updatedSections,
      expectedVersion: 2, // stale version
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoteConflictError);
    expect((error as InstanceType<typeof NoteConflictError>).message).toBe(
      "Note was modified by another user. Please refresh and try again.",
    );
    // Event should NOT have been emitted on conflict
    expect(emitClinicalEvent).not.toHaveBeenCalled();
  });

  it("throws when note is not found", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([]);

    await expect(
      updateNote("nonexistent", { sections: updatedSections }),
    ).rejects.toThrow("Note nonexistent not found");
  });
});
