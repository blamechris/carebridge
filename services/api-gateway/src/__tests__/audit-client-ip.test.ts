import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// HIPAA § 164.312(b) regression tests for issue #885.
//
// Before #885, every explicit audit_log insert in the gateway hard-coded
// `ip_address: ""` because the tRPC Context had no clientIp field. That left
// cosign/amend/emergency-access/care-team rows with an empty IP and broke
// forensic tracing.
//
// These tests verify each procedure now reads ctx.clientIp and writes it to
// the audit row.
// ---------------------------------------------------------------------------

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const PHYSICIAN_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_IP = "203.0.113.42";

// vi.mock() factories are hoisted above top-level code, so any state they
// reference must be declared via vi.hoisted() — otherwise the factory runs
// before the `const` initialisers and reads undefined.
const hoisted = vi.hoisted(() => {
  const AUDIT_TABLE = { __tableName: "audit_log" };
  const captured: { values: Record<string, unknown>[] } = { values: [] };
  // Row returned by the DB mock's select().limit() — overridden per test.
  // `null` means the SELECT returns `[]` (no row), which matters for
  // procedures whose first SELECT is an idempotency pre-check.
  const state: { selectRow: unknown } = {
    selectRow: { patient_id: "placeholder" },
  };

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    // `null` selectRow encodes "no match" so procedures whose first SELECT
    // is an idempotency/existence pre-check (careTeam.addMember post-#881)
    // fall through to the insert path.
    chain.limit = vi.fn(async () =>
      state.selectRow === null ? [] : [state.selectRow],
    );
    return chain;
  }

  function makeInsertChain(table: unknown) {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((v: Record<string, unknown>) => {
      if (table === AUDIT_TABLE) {
        captured.values.push(v);
      }
      return chain;
    });
    chain.then = (onFulfilled?: (v: unknown) => unknown) =>
      Promise.resolve(undefined).then(onFulfilled);
    return chain;
  }

  const mockDb: Record<string, unknown> = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn((table: unknown) => makeInsertChain(table)),
  };
  mockDb.transaction = vi.fn(
    async (cb: (tx: typeof mockDb) => Promise<void>) => {
      await cb(mockDb as typeof mockDb);
    },
  );

  return { AUDIT_TABLE, captured, state, mockDb };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => hoisted.mockDb,
  clinicalNotes: {
    id: "clinical_notes.id",
    patient_id: "clinical_notes.patient_id",
  },
  careTeamMembers: { id: "care_team_members.id" },
  careTeamAssignments: { id: "care_team_assignments.id" },
  emergencyAccess: { id: "emergency_access.id" },
  familyRelationships: {
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    status: "family_relationships.status",
    relationship_type: "family_relationships.relationship_type",
    access_scopes: "family_relationships.access_scopes",
  },
  users: { id: "users.id", patient_id: "users.patient_id" },
  auditLog: hoisted.AUDIT_TABLE,
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (col: unknown) => ({ isNull: col }),
  gt: (col: unknown, val: unknown) => ({ gt: col, val }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: vi.fn(async () => true),
  assertPermission: vi.fn(),
}));

vi.mock("@carebridge/clinical-notes", () => ({
  noteService: {
    createNote: vi.fn(),
    updateNote: vi.fn(),
    signNote: vi.fn(),
    cosignNote: vi.fn(async (noteId: string, cosignedBy: string) => ({
      id: noteId,
      status: "cosigned",
      cosigned_by: cosignedBy,
      cosigned_at: new Date().toISOString(),
      version: 1,
    })),
    amendNote: vi.fn(
      async (
        noteId: string,
        amendedBy: string,
        sections: unknown[],
        reason: string,
      ) => ({
        id: noteId,
        status: "amended",
        version: 2,
        sections,
        _reason: reason,
        _amendedBy: amendedBy,
      }),
    ),
    getVersionHistory: vi.fn(async () => []),
    getNotesByPatient: vi.fn(),
    getNoteById: vi.fn(),
  },
  createSOAPTemplate: () => ({}),
  createProgressTemplate: () => ({}),
}));

import { clinicalNotesRbacRouter } from "../routers/clinical-notes.js";
import { careTeamRbacRouter } from "../routers/care-team.js";
import { emergencyAccessRbacRouter } from "../routers/emergency-access.js";
import type { Context } from "../context.js";

function makePhysician(): User {
  return {
    id: PHYSICIAN_ID,
    email: "dr.smith@carebridge.dev",
    name: "Dr. Smith",
    role: "physician",
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeCtx(clientIp: string | null): Context {
  return {
    db: hoisted.mockDb as unknown as Context["db"],
    user: makePhysician(),
    sessionId: "session-1",
    requestId: "req-1",
    clientIp,
  };
}

// ---------------------------------------------------------------------------

describe("issue #885 — explicit audit_log rows carry ctx.clientIp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.captured.values = [];
    // Default existing-note row returned for cosign/amend preflight selects.
    hoisted.state.selectRow = { patient_id: PATIENT_ID };
  });

  it("clinicalNotes.cosign writes the caller IP into audit_log.ip_address", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(makeCtx(CLIENT_IP));

    await caller.cosign({ noteId: NOTE_ID });

    expect(hoisted.captured.values).toHaveLength(1);
    expect(hoisted.captured.values[0]).toMatchObject({
      action: "cosign",
      resource_type: "clinical_note",
      ip_address: CLIENT_IP,
    });
  });

  it("clinicalNotes.cosign falls back to empty string when clientIp is null", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(makeCtx(null));

    await caller.cosign({ noteId: NOTE_ID });

    expect(hoisted.captured.values).toHaveLength(1);
    // Explicit empty-string fallback: the audit_log schema's ip_address is
    // a non-null varchar on some migrations, so we never write null here.
    expect(hoisted.captured.values[0]!.ip_address).toBe("");
  });

  it("clinicalNotes.amend writes the caller IP into audit_log.ip_address", async () => {
    const caller = clinicalNotesRbacRouter.createCaller(makeCtx(CLIENT_IP));

    await caller.amend({
      noteId: NOTE_ID,
      sections: [
        {
          key: "subjective",
          label: "Subjective",
          fields: [],
          free_text: "Amended",
        },
      ],
      reason: "Correcting a dosage typo in the signed note",
    });

    expect(hoisted.captured.values).toHaveLength(1);
    expect(hoisted.captured.values[0]).toMatchObject({
      action: "amend",
      resource_type: "clinical_note",
      ip_address: CLIENT_IP,
    });
  });

  it("careTeam.addMember writes the caller IP into audit_log.ip_address", async () => {
    // post-#881: addMember does an idempotency pre-check. `null` signals
    // the SELECT returns no row so the insert path runs.
    hoisted.state.selectRow = null;
    const caller = careTeamRbacRouter.createCaller(makeCtx(CLIENT_IP));

    await caller.addMember({
      patient_id: PATIENT_ID,
      provider_id: PROVIDER_ID,
      role: "primary",
      specialty: "hematology_oncology",
    });

    // Care-team inserts audit rows inside a transaction alongside the
    // domain table. Only audit rows are captured (see mock filter), so the
    // length check is a direct read.
    expect(hoisted.captured.values).toHaveLength(1);
    expect(hoisted.captured.values[0]).toMatchObject({
      action: "care_team_add_member",
      ip_address: CLIENT_IP,
    });
  });

  it("emergencyAccess.request writes the caller IP into audit_log.ip_address", async () => {
    const caller = emergencyAccessRbacRouter.createCaller(makeCtx(CLIENT_IP));

    await caller.request({
      patientId: PATIENT_ID,
      justification:
        "Patient arrived unconscious; need allergy list before intubation",
    });

    // emergencyAccess.request inserts both emergency_access and audit_log.
    // The captured array is filtered to AUDIT_TABLE only.
    expect(hoisted.captured.values).toHaveLength(1);
    expect(hoisted.captured.values[0]).toMatchObject({
      action: "emergency_access",
      ip_address: CLIENT_IP,
    });
  });
});
