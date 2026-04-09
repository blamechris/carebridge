import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NoteSection } from "@carebridge/shared-types";

// ─── Mock @carebridge/db-schema ──────────────────────────────────
// The extractor calls db.query.clinicalNotes.findFirst, db.query.patients.findFirst,
// and db.insert(noteAssertions).values(row). We provide an in-memory fake that
// records every insert so tests can assert on the persisted row.

const fakeState = {
  notes: new Map<string, Record<string, unknown>>(),
  patients: new Map<string, Record<string, unknown>>(),
  inserted: [] as Record<string, unknown>[],
  // Phase D P1: patient_ai_consent rows. By default tests stage an active
  // grant so existing happy-path tests still reach the LLM call; the
  // consent_required test overrides this to exercise the default-deny
  // branch.
  consents: [] as Record<string, unknown>[],
};

function resetFakeState() {
  fakeState.notes.clear();
  fakeState.patients.clear();
  fakeState.inserted = [];
  fakeState.consents = [];
}

const fakeDb = {
  query: {
    clinicalNotes: {
      findFirst: vi.fn(async (args: { where: unknown }) => {
        // `where` is an eq() expression — we don't introspect it, we just
        // return the first note in the map that matches the id stored in
        // the last lookup. For tests we only ever stage one note.
        const notes = Array.from(fakeState.notes.values());
        return notes.length > 0 ? notes[0] : undefined;
      }),
    },
    patients: {
      findFirst: vi.fn(async (args: { where: unknown }) => {
        const rows = Array.from(fakeState.patients.values());
        return rows.length > 0 ? rows[0] : undefined;
      }),
    },
  },
  insert: vi.fn(() => ({
    values: vi.fn(async (row: Record<string, unknown>) => {
      fakeState.inserted.push(row);
    }),
  })),
  // Phase D P1: minimal select() chain for the consent lookup. The
  // consent-service calls:
  //   db.select().from(patientAiConsent).where(...).orderBy(...).limit(1)
  // We ignore the actual predicate and just return whatever the test
  // staged into fakeState.consents that looks "active".
  select: vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () =>
            fakeState.consents.filter((c) => c.revoked_at === null),
        }),
      }),
    }),
  })),
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => fakeDb,
  clinicalNotes: { id: "clinical_notes.id" } as const,
  patients: { id: "patients.id" } as const,
  noteAssertions: { id: "note_assertions.id" } as const,
  patientAiConsent: {
    id: "patient_ai_consent.id",
    patient_id: "patient_ai_consent.patient_id",
    scope: "patient_ai_consent.scope",
    granted_at: "patient_ai_consent.granted_at",
    revoked_at: "patient_ai_consent.revoked_at",
  } as const,
}));

// ─── Import extractor AFTER mocks are registered ─────────────────
import { extractNote } from "../extractors/note-extractor.js";

// ─── Test fixtures ───────────────────────────────────────────────

const NOTE_ID = "note-abc-123";
const PATIENT_ID = "patient-xyz-789";

const SAMPLE_SECTIONS: NoteSection[] = [
  {
    key: "subjective",
    label: "Subjective",
    fields: [
      {
        key: "chief_complaint",
        label: "Chief Complaint",
        value: "chest pain",
        field_type: "text",
        source: "new_entry",
      },
    ],
    free_text: "Patient reports chest pain for 3 days. Denies fever.",
  },
  {
    key: "assessment",
    label: "Assessment",
    fields: [
      {
        key: "problem",
        label: "Problem",
        value: "acute coronary syndrome",
        field_type: "text",
        source: "new_entry",
      },
    ],
  },
];

function stageNote(overrides: Partial<Record<string, unknown>> = {}) {
  fakeState.notes.set(NOTE_ID, {
    id: NOTE_ID,
    patient_id: PATIENT_ID,
    provider_id: "prov-1",
    encounter_id: null,
    template_type: "soap",
    sections: SAMPLE_SECTIONS,
    version: 1,
    status: "signed",
    signed_at: "2026-04-01T10:00:00.000Z",
    signed_by: "prov-1",
    cosigned_at: null,
    cosigned_by: null,
    copy_forward_score: null,
    source_system: "internal",
    created_at: "2026-04-01T10:00:00.000Z",
    ...overrides,
  });
  fakeState.patients.set(PATIENT_ID, {
    id: PATIENT_ID,
    name: "Test Patient",
    date_of_birth: "1960-01-15",
    mrn: "12345678",
  });
  // Default: stage an active llm_review consent so existing tests that
  // exercise the LLM path are not blocked by the Phase D P1 consent gate.
  // Tests that specifically exercise the consent-required branch clear
  // fakeState.consents before calling extractNote.
  fakeState.consents.push({
    id: "consent-1",
    patient_id: PATIENT_ID,
    scope: "llm_review",
    policy_version: "ai-consent-v1.0",
    granted_by_user_id: "user-patient",
    granted_by_relationship: "self",
    granted_at: "2026-03-15T00:00:00.000Z",
    revoked_at: null,
    revoked_by_user_id: null,
    revocation_reason: null,
    created_at: "2026-03-15T00:00:00.000Z",
  });
}

const VALID_RESPONSE = JSON.stringify({
  symptoms_reported: [
    {
      name: "chest pain",
      onset: "3 days ago",
      severity: null,
      evidence_quote: "Patient reports chest pain for 3 days.",
    },
  ],
  symptoms_denied: ["fever"],
  assessments: [
    {
      problem: "acute coronary syndrome",
      status: "new",
      evidence_quote: null,
    },
  ],
  plan_items: [],
  referenced_results: [],
  one_line_summary: "Patient presents with 3 days of chest pain, ACS workup initiated.",
});

// ─── Tests ───────────────────────────────────────────────────────

describe("extractNote", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    resetFakeState();
    fakeDb.insert.mockClear();
    process.env.AI_OVERSIGHT_LLM_ENABLED = "true";
    process.env.AI_OVERSIGHT_BAA_ACKNOWLEDGED = "true";
  });

  afterEach(() => {
    process.env.AI_OVERSIGHT_LLM_ENABLED = ORIGINAL_ENV.AI_OVERSIGHT_LLM_ENABLED;
    process.env.AI_OVERSIGHT_BAA_ACKNOWLEDGED =
      ORIGINAL_ENV.AI_OVERSIGHT_BAA_ACKNOWLEDGED;
  });

  it("persists a success row with the parsed payload on a happy path", async () => {
    stageNote();
    const llmCaller = vi.fn(async () => VALID_RESPONSE);

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(result.status).toBe("success");
    expect(result.error).toBeNull();
    expect(result.payload.symptoms_reported).toHaveLength(1);
    expect(result.payload.symptoms_reported[0].name).toBe("chest pain");
    expect(result.payload.symptoms_denied).toEqual(["fever"]);
    expect(result.payload.assessments[0].status).toBe("new");

    expect(fakeState.inserted).toHaveLength(1);
    const persisted = fakeState.inserted[0];
    expect(persisted.note_id).toBe(NOTE_ID);
    expect(persisted.patient_id).toBe(PATIENT_ID);
    expect(persisted.extraction_status).toBe("success");
    expect(persisted.model_id).toBe("claude-sonnet-4-6");
    expect(persisted.prompt_version).toBe("1.0.0");
    expect(persisted.error).toBeNull();
    expect(typeof persisted.processing_time_ms).toBe("number");
  });

  it("calls the LLM with the PHI-redacted note body, NOT the raw name", async () => {
    // Stage a note whose free_text contains the patient name — the extractor
    // must not send that name to the LLM.
    stageNote({
      sections: [
        {
          key: "subjective",
          label: "Subjective",
          fields: [],
          free_text: "Test Patient reports chest pain.",
        },
      ] as NoteSection[],
    });

    const llmCaller = vi.fn<(system: string, user: string) => Promise<string>>(
      async () => VALID_RESPONSE,
    );
    await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(llmCaller).toHaveBeenCalledOnce();
    const callArgs = llmCaller.mock.calls[0];
    expect(callArgs).toBeDefined();
    const userMessage = callArgs[1];
    expect(typeof userMessage).toBe("string");
    expect(userMessage).not.toMatch(/Test Patient/);
    // And the note-extraction prompt scaffold must be present.
    expect(userMessage).toMatch(/TEMPLATE TYPE: soap/);
    expect(userMessage).toMatch(/NOTE BODY:/);
  });

  it("persists llm_disabled and does NOT call the LLM when kill-switch is engaged", async () => {
    process.env.AI_OVERSIGHT_LLM_ENABLED = "false";
    stageNote();
    const llmCaller = vi.fn(async () => VALID_RESPONSE);

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(llmCaller).not.toHaveBeenCalled();
    expect(result.status).toBe("llm_disabled");
    expect(result.error).toMatch(/kill-switch/);
    expect(result.payload).toEqual({
      symptoms_reported: [],
      symptoms_denied: [],
      assessments: [],
      plan_items: [],
      referenced_results: [],
      one_line_summary: "",
    });
    expect(fakeState.inserted).toHaveLength(1);
    expect(fakeState.inserted[0].extraction_status).toBe("llm_disabled");
  });

  it("persists llm_disabled when BAA is not acknowledged", async () => {
    process.env.AI_OVERSIGHT_BAA_ACKNOWLEDGED = "false";
    stageNote();
    const llmCaller = vi.fn(async () => VALID_RESPONSE);

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(llmCaller).not.toHaveBeenCalled();
    expect(result.status).toBe("llm_disabled");
  });

  it("persists parse_failed when the LLM returns non-JSON", async () => {
    stageNote();
    const llmCaller = vi.fn(async () => "sorry I can't comply");

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(result.status).toBe("parse_failed");
    expect(result.error).toMatch(/not valid JSON/);
    expect(result.payload.symptoms_reported).toEqual([]);
    expect(fakeState.inserted[0].extraction_status).toBe("parse_failed");
  });

  it("persists parse_failed when the LLM returns a JSON array instead of an object", async () => {
    stageNote();
    const llmCaller = vi.fn(async () => "[]");

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(result.status).toBe("parse_failed");
    expect(result.error).toMatch(/not a JSON object/);
  });

  it("persists llm_failed when the LLM throws a non-kill-switch error", async () => {
    stageNote();
    const llmCaller = vi.fn(async () => {
      throw new Error("network timeout");
    });

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(result.status).toBe("llm_failed");
    expect(result.error).toBe("network timeout");
    expect(fakeState.inserted[0].extraction_status).toBe("llm_failed");
  });

  it("persists llm_disabled when LLMDisabledError is thrown mid-call (kill-switch race)", async () => {
    stageNote();
    const { LLMDisabledError } = await import("../services/claude-client.js");
    const llmCaller = vi.fn(async () => {
      throw new LLMDisabledError("race condition: flipped between gate and call");
    });

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(result.status).toBe("llm_disabled");
    expect(result.error).toMatch(/race condition/);
  });

  it("persists consent_required and does NOT call the LLM when the patient has no active AI consent", async () => {
    stageNote();
    // Clear the default consent staged by stageNote().
    fakeState.consents = [];
    const llmCaller = vi.fn(async () => VALID_RESPONSE);

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(llmCaller).not.toHaveBeenCalled();
    expect(result.status).toBe("consent_required");
    expect(result.error).toMatch(/consent/i);
    expect(fakeState.inserted).toHaveLength(1);
    expect(fakeState.inserted[0].extraction_status).toBe("consent_required");
    expect(result.payload).toEqual({
      symptoms_reported: [],
      symptoms_denied: [],
      assessments: [],
      plan_items: [],
      referenced_results: [],
      one_line_summary: "",
    });
  });

  it("persists consent_required when the only consent row has been revoked", async () => {
    stageNote();
    fakeState.consents = [
      {
        id: "revoked-1",
        patient_id: PATIENT_ID,
        scope: "llm_review",
        policy_version: "ai-consent-v1.0",
        granted_by_user_id: "user-patient",
        granted_by_relationship: "self",
        granted_at: "2026-03-01T00:00:00.000Z",
        revoked_at: "2026-03-10T00:00:00.000Z",
        revoked_by_user_id: "user-patient",
        revocation_reason: "patient withdrew",
        created_at: "2026-03-01T00:00:00.000Z",
      },
    ];
    const llmCaller = vi.fn(async () => VALID_RESPONSE);

    const result = await extractNote({ noteId: NOTE_ID, llmCaller });

    expect(llmCaller).not.toHaveBeenCalled();
    expect(result.status).toBe("consent_required");
  });

  it("throws when the note does not exist", async () => {
    // Stage no note.
    const llmCaller = vi.fn(async () => VALID_RESPONSE);
    await expect(
      extractNote({ noteId: "missing-note", llmCaller }),
    ).rejects.toThrow(/not found/);
    expect(fakeState.inserted).toHaveLength(0);
  });
});
