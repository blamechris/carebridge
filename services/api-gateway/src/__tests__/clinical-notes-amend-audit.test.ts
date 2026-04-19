/**
 * Amend audit completeness — regression tests for issue #886.
 *
 * The HIPAA amendment audit entry previously captured only the reason
 * and the new version. That left reviewers unable to distinguish an
 * amendment of a cosigned chart from an amendment of a signed-only
 * chart — clinically meaningful states with different downstream
 * review requirements. After #886, the audit `details` JSON carries:
 *
 *   - amended_by:        actor UUID (unchanged)
 *   - reason:            amendment rationale (unchanged)
 *   - old_status:        pre-amend status (signed | cosigned | amended)
 *   - new_status:        post-amend status (always "amended")
 *   - previous_version:  live-row version BEFORE the amend
 *   - new_version:       live-row version AFTER the amend
 *
 * These tests exercise the gateway router with a mocked DB that
 * captures the audit row so we can assert the full details payload
 * for each pre-amend status.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const PHYSICIAN_ID = "44444444-4444-4444-8444-444444444444";

type InsertedRow = { table: string; row: Record<string, unknown> };

const insertedRows: InsertedRow[] = [];
let preAmendRow: {
  patient_id: string;
  status: string;
  version: number;
} = {
  patient_id: PATIENT_ID,
  status: "signed",
  version: 3,
};

function tableOf(t: unknown): string {
  return (t as { __table?: string })?.__table ?? "unknown";
}

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => [preAmendRow]);
  return chain;
}

function makeInsertChain(table: unknown) {
  return {
    values: vi.fn(async (row: Record<string, unknown>) => {
      insertedRows.push({ table: tableOf(table), row });
    }),
  };
}

const mockDb = {
  select: vi.fn(() => makeSelectChain()),
  insert: vi.fn((table: unknown) => makeInsertChain(table)),
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  clinicalNotes: {
    __table: "clinical_notes",
    id: "clinical_notes.id",
    patient_id: "clinical_notes.patient_id",
    status: "clinical_notes.status",
    version: "clinical_notes.version",
  },
  auditLog: { __table: "audit_log", id: "audit_log.id" },
  familyRelationships: {},
  users: { id: "users.id", patient_id: "users.patient_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: vi.fn(async () => true),
}));

vi.mock("@carebridge/clinical-notes", () => ({
  noteService: {
    createNote: vi.fn(),
    updateNote: vi.fn(),
    signNote: vi.fn(),
    cosignNote: vi.fn(),
    amendNote: vi.fn(
      async (noteId: string, _amendedBy: string, sections: unknown[]) => ({
        id: noteId,
        status: "amended",
        version: preAmendRow.version + 1,
        sections,
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
import type { Context } from "../context.js";

function makeUser(role: User["role"] = "physician", id = PHYSICIAN_ID): User {
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

function callerFor(user: User) {
  const ctx: Context = {
    db: mockDb as unknown as Context["db"],
    user,
    sessionId: "s",
    requestId: "r",
    clientIp: "203.0.113.7",
  };
  return clinicalNotesRbacRouter.createCaller(ctx);
}

const sampleSection = {
  key: "s",
  label: "Subjective",
  fields: [],
  free_text: "Amended text",
};

const amendInput = {
  noteId: NOTE_ID,
  sections: [sampleSection],
  reason: "Correcting dose miscoded on signing.",
};

function auditRows(): InsertedRow[] {
  return insertedRows.filter((r) => r.table === "audit_log");
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  preAmendRow = { patient_id: PATIENT_ID, status: "signed", version: 3 };
});

describe("clinicalNotes.amend audit — old_status / new_status / previous_version (#886)", () => {
  it("writes audit details capturing the signed→amended transition", async () => {
    preAmendRow = { patient_id: PATIENT_ID, status: "signed", version: 3 };
    await callerFor(makeUser("physician")).amend(amendInput);

    expect(auditRows()).toHaveLength(1);
    const details = JSON.parse(auditRows()[0]!.row.details as string);
    expect(details).toMatchObject({
      amended_by: PHYSICIAN_ID,
      reason: amendInput.reason,
      old_status: "signed",
      new_status: "amended",
      previous_version: 3,
      new_version: 4,
    });
  });

  it("writes audit details capturing the cosigned→amended transition", async () => {
    preAmendRow = { patient_id: PATIENT_ID, status: "cosigned", version: 7 };
    await callerFor(makeUser("physician")).amend(amendInput);

    const details = JSON.parse(auditRows()[0]!.row.details as string);
    expect(details).toMatchObject({
      old_status: "cosigned",
      new_status: "amended",
      previous_version: 7,
      new_version: 8,
    });
  });

  it("writes audit details capturing the amended→amended (chain) transition", async () => {
    preAmendRow = { patient_id: PATIENT_ID, status: "amended", version: 12 };
    await callerFor(makeUser("physician")).amend(amendInput);

    const details = JSON.parse(auditRows()[0]!.row.details as string);
    expect(details).toMatchObject({
      old_status: "amended",
      new_status: "amended",
      previous_version: 12,
      new_version: 13,
    });
  });
});
