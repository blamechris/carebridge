/**
 * Internal clinical-notes router — actor spoofing regression (#884).
 *
 * The internal router's cosign / amend / sign procedures used to accept
 * `cosigned_by` / `amended_by` / `signed_by` in their Zod input via
 * `.extend()`. That shape is a latent spoofing vector: any caller that
 * could reach the internal router directly (bypassing the gateway's
 * `ctx.user.id` enforcement) would get to pick whose id gets written to
 * the note's cosigner / amender column.
 *
 * This test file pins the post-fix behaviour:
 *   1. Identity input fields are silently stripped at the Zod layer
 *      (so calls that include them still succeed — backward compatible
 *      for the gateway wrapper and existing clients).
 *   2. The actor id written to the DB is always ctx.actorId, never the
 *      stripped input field.
 *   3. Omitting ctx.actorId raises UNAUTHORIZED so misconfigured call
 *      sites fail loudly instead of silently attributing writes to "".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const CTX_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const SPOOFED_ACTOR_ID = "99999999-9999-4999-8999-999999999999";

const signNoteMock = vi.fn();
const cosignNoteMock = vi.fn();
const amendNoteMock = vi.fn();

// Stub the service + its db/event dependencies so the router can be
// imported without pulling in @carebridge/outbox (the real service's
// event-emit module) or a live DB. We export classes as class shims so
// `err instanceof NoteStateError` in the router still works.
vi.mock("../services/note-service.js", () => {
  class NoteStateError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NoteStateError";
    }
  }
  class NoteConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NoteConflictError";
    }
  }
  return {
    signNote: signNoteMock,
    cosignNote: cosignNoteMock,
    amendNote: amendNoteMock,
    createNote: vi.fn(),
    updateNote: vi.fn(),
    getNotesByPatient: vi.fn(),
    getNoteById: vi.fn(),
    getVersionHistory: vi.fn(async () => []),
    NoteStateError,
    NoteConflictError,
  };
});

const { clinicalNotesRouter } = await import("../router.js");

const sampleSection = {
  key: "s",
  label: "Subjective",
  fields: [],
  free_text: "Amended text",
};

function caller(actorId?: string) {
  return clinicalNotesRouter.createCaller({ actorId });
}

beforeEach(() => {
  vi.clearAllMocks();
  signNoteMock.mockResolvedValue({ id: NOTE_ID, status: "signed" });
  cosignNoteMock.mockResolvedValue({ id: NOTE_ID, status: "cosigned" });
  amendNoteMock.mockResolvedValue({ id: NOTE_ID, status: "amended" });
});

describe("internal clinical-notes router — sign actor resolution (#884)", () => {
  it("uses ctx.actorId as the signer, ignoring any stripped signed_by input", async () => {
    await caller(CTX_ACTOR_ID).sign({
      noteId: NOTE_ID,
      // @ts-expect-error — schema no longer accepts signed_by; runtime strips.
      signed_by: SPOOFED_ACTOR_ID,
    });
    expect(signNoteMock).toHaveBeenCalledWith(NOTE_ID, CTX_ACTOR_ID);
    expect(signNoteMock).not.toHaveBeenCalledWith(NOTE_ID, SPOOFED_ACTOR_ID);
  });

  it("raises UNAUTHORIZED when ctx.actorId is missing", async () => {
    await expect(
      caller().sign({ noteId: NOTE_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(signNoteMock).not.toHaveBeenCalled();
  });
});

describe("internal clinical-notes router — cosign actor resolution (#884)", () => {
  it("uses ctx.actorId as the cosigner, ignoring any stripped cosigned_by input", async () => {
    await caller(CTX_ACTOR_ID).cosign({
      noteId: NOTE_ID,
      // @ts-expect-error — schema no longer accepts cosigned_by.
      cosigned_by: SPOOFED_ACTOR_ID,
    });
    expect(cosignNoteMock).toHaveBeenCalledWith(NOTE_ID, CTX_ACTOR_ID);
    expect(cosignNoteMock).not.toHaveBeenCalledWith(NOTE_ID, SPOOFED_ACTOR_ID);
  });

  it("raises UNAUTHORIZED when ctx.actorId is missing", async () => {
    await expect(
      caller().cosign({ noteId: NOTE_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(cosignNoteMock).not.toHaveBeenCalled();
  });

  it("raises UNAUTHORIZED when ctx.actorId is an empty string", async () => {
    await expect(
      caller("").cosign({ noteId: NOTE_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(cosignNoteMock).not.toHaveBeenCalled();
  });
});

describe("internal clinical-notes router — amend actor resolution (#884)", () => {
  const amendInput = {
    noteId: NOTE_ID,
    sections: [sampleSection],
    reason: "Correcting dose miscoded on signing.",
  };

  it("uses ctx.actorId as the amender, ignoring any stripped amended_by input", async () => {
    await caller(CTX_ACTOR_ID).amend({
      ...amendInput,
      // @ts-expect-error — schema no longer accepts amended_by.
      amended_by: SPOOFED_ACTOR_ID,
    });
    expect(amendNoteMock).toHaveBeenCalledWith(
      NOTE_ID,
      CTX_ACTOR_ID,
      amendInput.sections,
      amendInput.reason,
    );
    // The spoof must never reach the service layer.
    const calls = amendNoteMock.mock.calls;
    expect(
      calls.every(([, actor]: unknown[]) => actor !== SPOOFED_ACTOR_ID),
    ).toBe(true);
  });

  it("raises UNAUTHORIZED when ctx.actorId is missing", async () => {
    await expect(caller().amend(amendInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(amendNoteMock).not.toHaveBeenCalled();
  });
});
