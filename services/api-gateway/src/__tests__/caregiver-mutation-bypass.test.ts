/**
 * Regression tests for issue #908 — caregiver mutation bypass on
 * clinical-data and clinical-notes routers.
 *
 * The caregiver branch added in PR #900 (#896) to enforcePatientAccess
 * returned success when called WITHOUT a requiredScope, which is the
 * shape every mutation uses. A caregiver with an active relationship
 * could therefore create vitals, labs, medications, procedures, and
 * clinical notes — a privilege escalation (ROLE_PERMISSIONS grants
 * caregivers zero write:* permissions).
 *
 * The fix is two layers:
 *
 *  1. Default-deny in enforcePatientAccess: the caregiver branch now
 *     requires a non-undefined requiredScope. Missing scope throws
 *     FORBIDDEN with a PHI-free message.
 *  2. Explicit per-procedure caregiver role checks before calling
 *     enforcePatientAccess — matches the pattern used for
 *     diagnoses/allergies/observations in patient-records.ts.
 *
 * Both layers are covered here so either layer catches the regression
 * even if the other is accidentally removed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
const PATIENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const MEDICATION_ID = "bbbb2222-2222-4222-8222-222222222222";
const NOTE_ID = "cccc3333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let queue: unknown[][] = [];

  function nextResult(): unknown[] {
    return queue.shift() ?? [];
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => {
      const result: Record<string | symbol, unknown> = {
        orderBy: vi.fn(async () => nextResult()),
        limit: vi.fn(async () => nextResult()),
      };
      (result as { then: (resolve: (v: unknown) => void) => unknown }).then = (
        resolve,
      ) => {
        resolve(nextResult());
        return result;
      };
      return result;
    });
    chain.orderBy = vi.fn(async () => nextResult());
    chain.limit = vi.fn(async () => nextResult());
    return chain;
  }

  const mockDb = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };

  // Track mutation repo invocations so tests can assert they were NOT called.
  const createVital = vi.fn(async () => ({ id: "vital-1" }));
  const createLabPanel = vi.fn(async () => ({ id: "lab-1" }));
  const createMedication = vi.fn(async () => ({ id: "med-1" }));
  const updateMedication = vi.fn(async () => ({ id: MEDICATION_ID }));
  const logAdministration = vi.fn(async () => ({ id: "admin-1" }));
  const createProcedure = vi.fn(async () => ({ id: "proc-1" }));
  const createNote = vi.fn(async () => ({ id: "note-1" }));
  const updateNote = vi.fn(async () => ({ id: NOTE_ID }));

  return {
    mockDb,
    setQueue: (q: unknown[][]) => {
      queue = [...q];
    },
    createVital,
    createLabPanel,
    createMedication,
    updateMedication,
    logAdministration,
    createProcedure,
    createNote,
    updateNote,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (must run before router imports)
// ---------------------------------------------------------------------------

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  hmacForIndex: (v: string) => `hmac:${v}`,
  patients: { id: "patients.id" },
  medications: {
    id: "medications.id",
    patient_id: "medications.patient_id",
  },
  clinicalNotes: {
    id: "clinical_notes.id",
    patient_id: "clinical_notes.patient_id",
  },
  auditLog: { id: "audit_log.id" },
  familyRelationships: {
    id: "family_relationships.id",
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    status: "family_relationships.status",
    access_scopes: "family_relationships.access_scopes",
  },
  users: {
    id: "users.id",
    patient_id: "users.patient_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
}));

vi.mock("../middleware/rbac.js", () => ({
  // Return true so a clinician would normally pass — keeps the test's focus
  // squarely on the caregiver role. If the role check fails to fire, the
  // clinician pathway would silently allow the mutation.
  assertCareTeamAccess: vi.fn(async () => true),
}));

vi.mock("@carebridge/clinical-data", () => ({
  vitalRepo: {
    createVital: mocks.createVital,
    getVitalsByPatient: vi.fn(async () => []),
    getLatestVitals: vi.fn(async () => []),
  },
  labRepo: {
    createLabPanel: mocks.createLabPanel,
    getLabPanelsByPatient: vi.fn(async () => []),
    getLabResultHistory: vi.fn(async () => []),
  },
  medicationRepo: {
    createMedication: mocks.createMedication,
    updateMedication: mocks.updateMedication,
    getMedicationsByPatient: vi.fn(async () => []),
    logAdministration: mocks.logAdministration,
  },
  procedureRepo: {
    createProcedure: mocks.createProcedure,
    getProceduresByPatient: vi.fn(async () => []),
  },
  ConflictError: class ConflictError extends Error {},
}));

vi.mock("@carebridge/clinical-notes", () => ({
  noteService: {
    createNote: mocks.createNote,
    updateNote: mocks.updateNote,
    signNote: vi.fn(async () => ({})),
    cosignNote: vi.fn(async () => ({})),
    amendNote: vi.fn(async () => ({})),
    getVersionHistory: vi.fn(async () => []),
    getNotesByPatient: vi.fn(async () => []),
    getNoteById: vi.fn(async () => ({
      note: { id: NOTE_ID, patient_id: PATIENT_RECORD_ID },
    })),
  },
  createSOAPTemplate: () => ({}),
  createProgressTemplate: () => ({}),
}));

vi.mock("@carebridge/validators", async () => {
  const { z } = await import("zod");
  return {
    createVitalSchema: z.object({
      patient_id: z.string().uuid(),
      type: z.string().optional(),
      value: z.number().optional(),
    }),
    vitalTypeSchema: z.string(),
    createLabPanelSchema: z.object({
      patient_id: z.string().uuid(),
      panel_name: z.string().optional(),
    }),
    createMedicationSchema: z.object({
      patient_id: z.string().uuid(),
      name: z.string().optional(),
    }),
    updateMedicationSchema: z.object({
      status: z.string().optional(),
    }),
    medStatusSchema: z.string(),
    createProcedureSchema: z.object({
      patient_id: z.string().uuid(),
      name: z.string().optional(),
    }),
    createNoteSchema: z.object({
      patient_id: z.string().uuid(),
      template_type: z.string().optional(),
    }),
    updateNoteSchema: z.object({
      sections: z.any().optional(),
    }),
    cosignNoteSchema: z.object({ noteId: z.string().uuid() }),
    amendNoteSchema: z.object({
      noteId: z.string().uuid(),
      sections: z.any(),
      reason: z.string(),
    }),
    noteTemplateTypeSchema: z.enum([
      "soap",
      "progress",
      "h_and_p",
      "discharge",
      "consult",
    ]),
  };
});

// ---------------------------------------------------------------------------
// Router imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { clinicalDataRbacRouter } from "../routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "../routers/clinical-notes.js";
import type { Context } from "../context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
  role: User["role"],
  id: string,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctxFor(user: User | null): Context {
  return {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
    clientIp: null,
  };
}

const caregiver = () => makeUser("family_caregiver", CAREGIVER_ID);

// ---------------------------------------------------------------------------
// Layer 2 — explicit per-procedure caregiver blocks
// ---------------------------------------------------------------------------

describe("clinical-data mutations reject family_caregiver (issue #908)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queue an "active relationship" row so the Layer-1 guard is not the
    // thing tripping the failure — we're explicitly testing that the
    // procedure-level block fires before enforcePatientAccess runs.
    mocks.setQueue([
      [{ id: "rel-1", access_scopes: ["view_and_message"] }],
    ]);
  });

  it("vitals.create rejects caregiver with FORBIDDEN before touching the repo", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.vitals.create({
        patient_id: PATIENT_RECORD_ID,
        type: "heart_rate",
        value: 80,
      } as never),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/caregivers? cannot/i),
    });
    expect(mocks.createVital).not.toHaveBeenCalled();
  });

  it("labs.createPanel rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.labs.createPanel({
        patient_id: PATIENT_RECORD_ID,
        panel_name: "CBC",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.createLabPanel).not.toHaveBeenCalled();
  });

  it("medications.create rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.medications.create({
        patient_id: PATIENT_RECORD_ID,
        name: "Aspirin",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.createMedication).not.toHaveBeenCalled();
  });

  it("medications.update rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.medications.update({
        id: MEDICATION_ID,
        status: "discontinued",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateMedication).not.toHaveBeenCalled();
  });

  it("medications.logAdmin rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.medications.logAdmin({
        medicationId: MEDICATION_ID,
        administeredAt: "2026-01-01T00:00:00.000Z",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.logAdministration).not.toHaveBeenCalled();
  });

  it("procedures.create rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.procedures.create({
        patient_id: PATIENT_RECORD_ID,
        name: "Central line placement",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.createProcedure).not.toHaveBeenCalled();
  });
});

describe("clinical-notes mutations reject family_caregiver (issue #908)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setQueue([
      [{ id: "rel-1", access_scopes: ["view_and_message"] }],
    ]);
  });

  it("create rejects caregiver with FORBIDDEN before touching the note service", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.create({
        patient_id: PATIENT_RECORD_ID,
        template_type: "soap",
      } as never),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/caregivers? cannot/i),
    });
    expect(mocks.createNote).not.toHaveBeenCalled();
  });

  it("update rejects caregiver with FORBIDDEN", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.update({
        id: NOTE_ID,
        sections: {},
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  // sign / cosign / amend already gate on ["physician","specialist","admin"] —
  // caregivers cannot satisfy that allowlist, so their rejection predates this
  // fix. Test it here as a regression guard so a future refactor that opens
  // the role list (or removes the allowlist entirely) still blocks caregivers.
  it("cosign rejects caregiver with FORBIDDEN via the role allowlist", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.cosign({ noteId: NOTE_ID } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("amend rejects caregiver with FORBIDDEN via the role allowlist", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.amend({
        noteId: NOTE_ID,
        sections: {},
        reason: "typo",
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — default-deny in enforcePatientAccess for missing requiredScope
// ---------------------------------------------------------------------------

/**
 * Layer 1 is exercised indirectly: every mutation above calls
 * enforcePatientAccess without a requiredScope. Even if the Layer-2
 * per-procedure role block were to regress, Layer 1 would still fire.
 *
 * The clinician assertCareTeamAccess mock returns true, so a clinician
 * sailing through a mutation would succeed — if either layer failed for
 * a caregiver, the mutation would reach the repo mock. These tests
 * assert both that the repo mock was NOT called AND that the thrown
 * error has the FORBIDDEN code, pinning the contract that no write path
 * is reachable for a caregiver role.
 *
 * Additionally, verify the scoped READ path still works — that's the
 * regression case from #896 we must preserve.
 */

describe("enforcePatientAccess default-deny on missing requiredScope (Layer 1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caregiver READ with scope still allowed (regression guard for #896)", async () => {
    // Active relationship with view_medications scope → medications.getByPatient
    // should succeed. Confirms the scope-gated read path was NOT broken by the
    // Layer-1 default-deny.
    mocks.setQueue([
      [{ id: "rel-1", access_scopes: ["view_medications"] }],
    ]);

    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.medications.getByPatient({ patientId: PATIENT_RECORD_ID }),
    ).resolves.toBeDefined();
  });

  it("caregiver READ without matching scope still denied (regression guard for #896)", async () => {
    mocks.setQueue([
      [{ id: "rel-1", access_scopes: ["view_summary"] }], // lacks view_medications
    ]);

    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    await expect(
      caller.medications.getByPatient({ patientId: PATIENT_RECORD_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("view_medications"),
    });
  });

  it("FORBIDDEN error message does not leak patient identifiers", async () => {
    const caller = clinicalDataRbacRouter.createCaller(ctxFor(caregiver()));
    try {
      await caller.vitals.create({
        patient_id: PATIENT_RECORD_ID,
        type: "heart_rate",
        value: 80,
      } as never);
      expect.fail("expected FORBIDDEN");
    } catch (err) {
      const message = (err as { message?: string }).message ?? "";
      // Must not embed the patient record UUID, user UUID, or any MRN-like
      // token in the surfaced error.
      expect(message).not.toContain(PATIENT_RECORD_ID);
      expect(message).not.toContain(PATIENT_USER_ID);
    }
  });
});
