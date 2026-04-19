import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_IDS: Record<string, string> = {
  nurse: "33333333-3333-4333-8333-333333333333",
  physician: "44444444-4444-4444-8444-444444444444",
  specialist: "55555555-5555-4555-8555-555555555555",
  admin: "66666666-6666-4666-8666-666666666666",
  patient: PATIENT_ID,
};

// Mock DB: every select returns the note row so access checks never 404.
function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => [{ patient_id: PATIENT_ID }]);
  return chain;
}

// Mock insert chain used by the explicit audit write in cosign/amend. The
// production path awaits db.insert(auditLog).values(...), so we return a
// thenable that resolves to `undefined` no matter how long the chain is.
function makeInsertChain() {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.then = (onFulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(undefined).then(onFulfilled);
  return chain;
}

const mockDb = {
  select: vi.fn(() => makeSelectChain()),
  insert: vi.fn(() => makeInsertChain()),
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  clinicalNotes: {
    id: "clinical_notes.id",
    patient_id: "clinical_notes.patient_id",
  },
  auditLog: { id: "audit_log.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

// Always grant care-team access so the only gate under test is the role check.
vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: vi.fn(async () => true),
}));

// Stub the note service so signNote does not touch a real DB.
vi.mock("@carebridge/clinical-notes", () => ({
  noteService: {
    createNote: vi.fn(),
    updateNote: vi.fn(),
    signNote: vi.fn(async (noteId: string, signedBy: string) => ({
      id: noteId,
      signed_by: signedBy,
      signed_at: new Date().toISOString(),
    })),
    cosignNote: vi.fn(async (noteId: string, cosignedBy: string) => ({
      id: noteId,
      status: "cosigned",
      cosigned_by: cosignedBy,
      cosigned_at: new Date().toISOString(),
      version: 1,
    })),
    amendNote: vi.fn(async (noteId: string, amendedBy: string, sections: unknown[], reason: string) => ({
      id: noteId,
      status: "amended",
      version: 2,
      sections,
      _reason: reason,
      _amendedBy: amendedBy,
    })),
    getVersionHistory: vi.fn(async () => []),
    getNotesByPatient: vi.fn(),
    getNoteById: vi.fn(),
  },
  createSOAPTemplate: () => ({}),
  createProgressTemplate: () => ({}),
}));

import { noteService } from "@carebridge/clinical-notes";
import { clinicalNotesRbacRouter } from "../routers/clinical-notes.js";
import type { Context } from "../context.js";

const signNoteMock = vi.mocked(noteService.signNote);
const cosignNoteMock = vi.mocked(noteService.cosignNote);
const amendNoteMock = vi.mocked(noteService.amendNote);
const getVersionHistoryMock = vi.mocked(noteService.getVersionHistory);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(role: User["role"], id = ROLE_IDS[role]!): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeContext(user: User | null): Context {
  return {
    db: mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
    clientIp: null,
  };
}

function callerFor(user: User | null) {
  return clinicalNotesRbacRouter.createCaller(makeContext(user));
}

const signInput = {
  noteId: NOTE_ID,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clinicalNotesRbacRouter.sign — role enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signNoteMock.mockClear();
  });

  it("rejects a nurse attempting to sign a note (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("nurse"));

    await expect(caller.sign(signInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(signNoteMock).not.toHaveBeenCalled();
  });

  it("rejects a patient attempting to sign a note (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));

    await expect(caller.sign(signInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(signNoteMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);

    await expect(caller.sign(signInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(signNoteMock).not.toHaveBeenCalled();
  });

  it("allows a physician to sign a note (signer = ctx.user.id)", async () => {
    const physician = makeUser("physician");
    const caller = callerFor(physician);

    await expect(caller.sign(signInput)).resolves.toBeDefined();
    expect(signNoteMock).toHaveBeenCalledWith(NOTE_ID, physician.id);
  });

  it("allows a specialist to sign a note (signer = ctx.user.id)", async () => {
    const specialist = makeUser("specialist");
    const caller = callerFor(specialist);

    await expect(caller.sign(signInput)).resolves.toBeDefined();
    expect(signNoteMock).toHaveBeenCalledWith(NOTE_ID, specialist.id);
  });

  it("allows an admin to sign a note (signer = ctx.user.id)", async () => {
    const admin = makeUser("admin");
    const caller = callerFor(admin);

    await expect(caller.sign(signInput)).resolves.toBeDefined();
    expect(signNoteMock).toHaveBeenCalledWith(NOTE_ID, admin.id);
  });

  it("ignores client-supplied signed_by — signature uses ctx.user.id only", async () => {
    const physicianA = makeUser("physician");
    const caller = callerFor(physicianA);

    // Even if a client sneaks in an extra `signed_by` field, the wrapper's
    // input schema strips it and the mutation always passes ctx.user.id to
    // noteService.signNote. This is the regression guard for the spoofing
    // bug Copilot flagged on PR #372.
    await expect(
      caller.sign({
        noteId: NOTE_ID,
        // @ts-expect-error — schema deliberately rejects extra fields at
        // type level; runtime strips them.
        signed_by: "00000000-0000-0000-0000-aaaaaaaaaaaa",
      }),
    ).resolves.toBeDefined();
    expect(signNoteMock).toHaveBeenCalledWith(NOTE_ID, physicianA.id);
  });
});

// ---------------------------------------------------------------------------
// cosign
// ---------------------------------------------------------------------------

describe("clinicalNotesRbacRouter.cosign — role enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cosignNoteMock.mockClear();
  });

  const cosignInput = { noteId: NOTE_ID };

  it("rejects a nurse attempting to cosign (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.cosign(cosignInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cosignNoteMock).not.toHaveBeenCalled();
  });

  it("rejects a patient attempting to cosign (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(caller.cosign(cosignInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cosignNoteMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(caller.cosign(cosignInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(cosignNoteMock).not.toHaveBeenCalled();
  });

  it("allows a physician to cosign (cosigner = ctx.user.id)", async () => {
    const physician = makeUser("physician");
    const caller = callerFor(physician);
    await expect(caller.cosign(cosignInput)).resolves.toBeDefined();
    expect(cosignNoteMock).toHaveBeenCalledWith(NOTE_ID, physician.id);
  });

  it("allows a specialist to cosign", async () => {
    const specialist = makeUser("specialist");
    const caller = callerFor(specialist);
    await expect(caller.cosign(cosignInput)).resolves.toBeDefined();
    expect(cosignNoteMock).toHaveBeenCalledWith(NOTE_ID, specialist.id);
  });

  it("surfaces NoteStateError from the service as a CONFLICT", async () => {
    cosignNoteMock.mockImplementationOnce(async () => {
      const e = new Error("Cannot cosign note in status \"draft\"");
      e.name = "NoteStateError";
      throw e;
    });

    const caller = callerFor(makeUser("physician"));
    await expect(caller.cosign(cosignInput)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// amend
// ---------------------------------------------------------------------------

const sampleSection = {
  key: "subjective",
  label: "Subjective",
  fields: [],
  free_text: "Amended text",
};

describe("clinicalNotesRbacRouter.amend — role enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    amendNoteMock.mockClear();
  });

  const amendInput = {
    noteId: NOTE_ID,
    sections: [sampleSection],
    reason: "Dose was miscoded on signing — correcting to 5mg.",
  };

  it("rejects a nurse attempting to amend (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.amend(amendInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(amendNoteMock).not.toHaveBeenCalled();
  });

  it("rejects a patient attempting to amend (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(caller.amend(amendInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(amendNoteMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(caller.amend(amendInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(amendNoteMock).not.toHaveBeenCalled();
  });

  it("allows a physician to amend with a valid reason", async () => {
    const physician = makeUser("physician");
    const caller = callerFor(physician);
    await expect(caller.amend(amendInput)).resolves.toBeDefined();
    expect(amendNoteMock).toHaveBeenCalledWith(
      NOTE_ID,
      physician.id,
      amendInput.sections,
      amendInput.reason,
    );
  });

  it("rejects an empty reason at the schema layer", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.amend({ ...amendInput, reason: "" }),
    ).rejects.toBeDefined();
    expect(amendNoteMock).not.toHaveBeenCalled();
  });

  it("surfaces NoteStateError from the service as a CONFLICT", async () => {
    amendNoteMock.mockImplementationOnce(async () => {
      const e = new Error("Cannot amend a draft note");
      e.name = "NoteStateError";
      throw e;
    });

    const caller = callerFor(makeUser("physician"));
    await expect(caller.amend(amendInput)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// getVersionHistory
// ---------------------------------------------------------------------------

describe("clinicalNotesRbacRouter.getVersionHistory — access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVersionHistoryMock.mockClear();
  });

  const input = { noteId: NOTE_ID };

  it("rejects an unauthenticated caller", async () => {
    const caller = callerFor(null);
    await expect(caller.getVersionHistory(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getVersionHistoryMock).not.toHaveBeenCalled();
  });

  it("allows a clinician on the care team", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(caller.getVersionHistory(input)).resolves.toEqual([]);
    expect(getVersionHistoryMock).toHaveBeenCalledWith(NOTE_ID);
  });

  it("allows a nurse on the care team (read permission)", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.getVersionHistory(input)).resolves.toEqual([]);
    expect(getVersionHistoryMock).toHaveBeenCalledWith(NOTE_ID);
  });
});
