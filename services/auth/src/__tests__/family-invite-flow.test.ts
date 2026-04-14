/**
 * Tests for the family access service layer.
 *
 * Covers:
 *   - Ownership validation for revokeFamilyAccess and cancelFamilyInvite
 *     (issue #305).
 *   - Self-invite, duplicate-relationship, and race-condition protections
 *     in createFamilyInvite and acceptFamilyInvite (issue #308).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// ---------------------------------------------------------------------------
// Mock @carebridge/db-schema
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let relationshipRows: Row[] = [];
let inviteRows: Row[] = [];
let userRows: Row[] = [];
const insertedRows: Row[] = [];
const updatedSets: Row[] = [];

// Controls which virtual "table" the next .select() call reads from.
// Tests set this before each call path. When a procedure performs more
// than one SELECT, set selectScript to queue per-call targets.
type SelectTarget = "relationships" | "invites" | "users";
let selectTarget: SelectTarget = "relationships";
let selectScript: SelectTarget[] | null = null;

function rowsFor(target: SelectTarget): Row[] {
  switch (target) {
    case "relationships":
      return relationshipRows;
    case "invites":
      return inviteRows;
    case "users":
      return userRows;
  }
}

function makeSelectChain(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.for = vi.fn(() => chain); // SELECT ... FOR UPDATE
  chain.limit = vi.fn(() => Promise.resolve(rows));
  (chain as { then?: unknown }).then = (onFulfilled: (r: Row[]) => unknown) =>
    Promise.resolve(rows).then(onFulfilled);
  return chain;
}

// The shared tx / db surface. tx.transaction just invokes the callback
// synchronously with itself so we can exercise the transactional path
// without a real database.
function makeDbLike() {
  const self: Record<string, unknown> = {};
  self.select = vi.fn(() => {
    const target = selectScript ? selectScript.shift() ?? selectTarget : selectTarget;
    return makeSelectChain(rowsFor(target));
  });
  self.insert = vi.fn(() => ({
    values: vi.fn((row: Row) => {
      insertedRows.push(row);
      return Promise.resolve();
    }),
  }));
  self.update = vi.fn(() => ({
    set: vi.fn((row: Row) => ({
      where: vi.fn(() => {
        updatedSets.push(row);
        return Promise.resolve();
      }),
    })),
  }));
  self.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn(self);
  });
  return self;
}

const mockDb = makeDbLike();

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  familyRelationships: {
    __table: "family_relationships",
    id: "family_relationships.id",
    patient_id: "family_relationships.patient_id",
    caregiver_id: "family_relationships.caregiver_id",
    status: "family_relationships.status",
  },
  familyInvites: {
    __table: "family_invites",
    id: "family_invites.id",
    patient_id: "family_invites.patient_id",
    token: "family_invites.token",
    status: "family_invites.status",
  },
  users: {
    __table: "users",
    id: "users.id",
    email: "users.email",
  },
  auditLog: {
    __table: "audit_log",
    id: "audit_log.id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ op: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
}));

// Import AFTER mocks are installed
const {
  createFamilyInvite,
  acceptFamilyInvite,
  revokeFamilyAccess,
  cancelFamilyInvite,
} = await import("../family-invite-flow.js");

// ---------------------------------------------------------------------------

const PATIENT_A = "patient-aaa";
const PATIENT_B = "patient-bbb";
const CAREGIVER = "caregiver-ccc";
const ADMIN = "admin-ddd";
const REL_ID = "rel-123";
const INVITE_ID = "inv-456";

const PATIENT_EMAIL = "patient-a@example.com";
const CAREGIVER_EMAIL = "caregiver@example.com";

function defaultSelect() {
  const target = selectScript ? selectScript.shift() ?? selectTarget : selectTarget;
  return makeSelectChain(rowsFor(target));
}

function defaultInsert() {
  return {
    values: vi.fn((row: Row) => {
      insertedRows.push(row);
      return Promise.resolve();
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  relationshipRows = [];
  inviteRows = [];
  userRows = [];
  insertedRows.length = 0;
  updatedSets.length = 0;
  selectTarget = "relationships";
  selectScript = null;
  // Reset implementations that individual tests may have overridden.
  (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(defaultSelect);
  (mockDb.insert as ReturnType<typeof vi.fn>).mockImplementation(defaultInsert);
});

// ---------------------------------------------------------------------------
// createFamilyInvite  (issue #308)
// ---------------------------------------------------------------------------

describe("createFamilyInvite", () => {
  it("creates an invite when patient exists and no duplicate relationship", async () => {
    // SELECT order inside createFamilyInvite:
    //   1. users (patient lookup) -> the patient row
    //   2. users (caregiver lookup by email) -> empty (no account yet)
    const calls: Row[][] = [
      [{ id: PATIENT_A, email: PATIENT_EMAIL }],
      [],
    ];
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain(calls.shift() ?? []),
    );

    const result = await createFamilyInvite(
      PATIENT_A,
      CAREGIVER_EMAIL,
      "spouse",
    );

    expect(result.id).toBeDefined();
    expect(result.token).toMatch(/^[0-9a-f]+$/);
    // Invite insert + audit log insert.
    expect(insertedRows.length).toBeGreaterThanOrEqual(2);
    const invite = insertedRows.find((r) => r.token !== undefined);
    expect(invite).toMatchObject({
      patient_id: PATIENT_A,
      invitee_email: CAREGIVER_EMAIL, // normalized (already lowercase)
      relationship_type: "spouse",
      status: "pending",
    });
  });

  it("rejects a self-invite (invitee email matches patient email)", async () => {
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([{ id: PATIENT_A, email: PATIENT_EMAIL }]),
    );

    await expect(
      createFamilyInvite(PATIENT_A, PATIENT_EMAIL, "spouse"),
    ).rejects.toThrow(TRPCError);

    try {
      await createFamilyInvite(PATIENT_A, PATIENT_EMAIL, "spouse");
    } catch (err) {
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
      expect((err as TRPCError).message).toMatch(/yourself/i);
    }

    // No invite should have been inserted.
    expect(insertedRows.find((r) => r.token !== undefined)).toBeUndefined();
  });

  it("rejects a self-invite even with different email case / whitespace", async () => {
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([{ id: PATIENT_A, email: PATIENT_EMAIL }]),
    );

    const variant = `  ${PATIENT_EMAIL.toUpperCase()}  `;

    await expect(
      createFamilyInvite(PATIENT_A, variant, "spouse"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects when an active relationship already exists for this pair", async () => {
    const calls: Row[][] = [
      [{ id: PATIENT_A, email: PATIENT_EMAIL }], // patient lookup
      [{ id: CAREGIVER }], // existing caregiver user
      [{ id: REL_ID }], // existing active relationship
    ];
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain(calls.shift() ?? []),
    );

    await expect(
      createFamilyInvite(PATIENT_A, CAREGIVER_EMAIL, "spouse"),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // No invite insert.
    expect(insertedRows.find((r) => r.token !== undefined)).toBeUndefined();
  });

  it("throws NOT_FOUND if the patient does not exist", async () => {
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([]),
    );

    await expect(
      createFamilyInvite("nonexistent", CAREGIVER_EMAIL, "spouse"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// acceptFamilyInvite  (issue #308 — transactional, duplicate-safe)
// ---------------------------------------------------------------------------

describe("acceptFamilyInvite", () => {
  const pendingInvite = {
    id: INVITE_ID,
    patient_id: PATIENT_A,
    invitee_email: CAREGIVER_EMAIL,
    relationship_type: "spouse",
    status: "pending",
    token: "valid-token",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a valid pending invite inside a transaction", async () => {
    const calls: Row[][] = [
      [pendingInvite], // invite SELECT ... FOR UPDATE
      [], // duplicate-relationship check: none
    ];
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain(calls.shift() ?? []),
    );

    const result = await acceptFamilyInvite("valid-token", CAREGIVER);

    expect(result.relationship_id).toBeDefined();
    // Must have used a transaction.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // Invite status -> accepted.
    expect(updatedSets.some((u) => u.status === "accepted")).toBe(true);
    // Relationship inserted.
    expect(
      insertedRows.some((r) => r.status === "active" && r.caregiver_id === CAREGIVER),
    ).toBe(true);
  });

  it("uses SELECT ... FOR UPDATE to lock the invite row", async () => {
    let forUpdateCalled = false;
    const calls: Row[][] = [[pendingInvite], []];
    let idx = 0;
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const chain = makeSelectChain(calls[idx] ?? []);
      if (idx === 0) {
        chain.for = vi.fn((mode: string) => {
          if (mode === "update") forUpdateCalled = true;
          return chain;
        });
      }
      idx += 1;
      return chain;
    });

    await acceptFamilyInvite("valid-token", CAREGIVER);

    expect(forUpdateCalled).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects if an active relationship already exists (duplicate)", async () => {
    const calls: Row[][] = [
      [pendingInvite],
      [{ id: "existing-rel" }], // duplicate found
    ];
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain(calls.shift() ?? []),
    );

    await expect(
      acceptFamilyInvite("valid-token", CAREGIVER),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Invite should not have been updated to accepted.
    expect(updatedSets.some((u) => u.status === "accepted")).toBe(false);
    // No relationship inserted.
    expect(insertedRows.some((r) => r.status === "active")).toBe(false);
  });

  it("rejects if the accepting user is the patient themselves", async () => {
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([pendingInvite]),
    );

    await expect(
      acceptFamilyInvite("valid-token", PATIENT_A),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("throws NOT_FOUND for an invalid token", async () => {
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([]),
    );

    await expect(
      acceptFamilyInvite("bad-token", CAREGIVER),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws BAD_REQUEST for an expired invite", async () => {
    const expired = {
      ...pendingInvite,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([expired]),
    );

    await expect(
      acceptFamilyInvite("valid-token", CAREGIVER),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps unique-violation errors from the DB to CONFLICT", async () => {
    const calls: Row[][] = [
      [pendingInvite],
      [], // duplicate-check passes
    ];
    (mockDb.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain(calls.shift() ?? []),
    );

    // Make the relationship insert throw a unique violation.
    (mockDb.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      values: vi.fn((row: Row) => {
        if (row.status === "active" && row.caregiver_id === CAREGIVER) {
          const err = new Error("duplicate key value violates unique constraint");
          (err as unknown as { code: string }).code = "23505";
          return Promise.reject(err);
        }
        insertedRows.push(row);
        return Promise.resolve();
      }),
    }));

    await expect(
      acceptFamilyInvite("valid-token", CAREGIVER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// revokeFamilyAccess
// ---------------------------------------------------------------------------

describe("revokeFamilyAccess", () => {
  const activeRelationship = {
    id: REL_ID,
    patient_id: PATIENT_A,
    caregiver_id: CAREGIVER,
    status: "active",
    relationship_type: "spouse",
    granted_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("allows the owning patient to revoke", async () => {
    selectTarget = "relationships";
    relationshipRows = [activeRelationship];

    await revokeFamilyAccess(REL_ID, PATIENT_A, "patient");

    expect(updatedSets.length).toBeGreaterThanOrEqual(1);
    expect(updatedSets[0]).toMatchObject({ status: "revoked" });
  });

  it("allows the caregiver to revoke their own access", async () => {
    selectTarget = "relationships";
    relationshipRows = [activeRelationship];

    await revokeFamilyAccess(REL_ID, CAREGIVER, "patient");

    expect(updatedSets.length).toBeGreaterThanOrEqual(1);
    expect(updatedSets[0]).toMatchObject({ status: "revoked" });
  });

  it("allows an admin to revoke any relationship", async () => {
    selectTarget = "relationships";
    relationshipRows = [activeRelationship];

    await revokeFamilyAccess(REL_ID, ADMIN, "admin");

    expect(updatedSets.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a different patient (FORBIDDEN)", async () => {
    selectTarget = "relationships";
    relationshipRows = [activeRelationship];

    await expect(
      revokeFamilyAccess(REL_ID, PATIENT_B, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await revokeFamilyAccess(REL_ID, PATIENT_B, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
  });

  it("throws NOT_FOUND for nonexistent relationship", async () => {
    selectTarget = "relationships";
    relationshipRows = [];

    await expect(
      revokeFamilyAccess("nonexistent", PATIENT_A, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await revokeFamilyAccess("nonexistent", PATIENT_A, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  it("throws BAD_REQUEST for already-revoked relationship", async () => {
    selectTarget = "relationships";
    relationshipRows = [{ ...activeRelationship, status: "revoked" }];

    await expect(
      revokeFamilyAccess(REL_ID, PATIENT_A, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await revokeFamilyAccess(REL_ID, PATIENT_A, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    }
  });
});

// ---------------------------------------------------------------------------
// cancelFamilyInvite
// ---------------------------------------------------------------------------

describe("cancelFamilyInvite", () => {
  const pendingInvite = {
    id: INVITE_ID,
    patient_id: PATIENT_A,
    invitee_email: "family@example.com",
    relationship_type: "spouse",
    status: "pending",
    token: "some-token",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("allows the owning patient to cancel", async () => {
    selectTarget = "invites";
    inviteRows = [pendingInvite];

    await cancelFamilyInvite(INVITE_ID, PATIENT_A, "patient");

    expect(updatedSets.length).toBeGreaterThanOrEqual(1);
    expect(updatedSets[0]).toMatchObject({ status: "cancelled" });
  });

  it("allows an admin to cancel any invite", async () => {
    selectTarget = "invites";
    inviteRows = [pendingInvite];

    await cancelFamilyInvite(INVITE_ID, ADMIN, "admin");

    expect(updatedSets.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a different patient (FORBIDDEN)", async () => {
    selectTarget = "invites";
    inviteRows = [pendingInvite];

    await expect(
      cancelFamilyInvite(INVITE_ID, PATIENT_B, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await cancelFamilyInvite(INVITE_ID, PATIENT_B, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
  });

  it("throws NOT_FOUND for nonexistent invite", async () => {
    selectTarget = "invites";
    inviteRows = [];

    await expect(
      cancelFamilyInvite("nonexistent", PATIENT_A, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await cancelFamilyInvite("nonexistent", PATIENT_A, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  it("throws BAD_REQUEST for non-pending invite", async () => {
    selectTarget = "invites";
    inviteRows = [{ ...pendingInvite, status: "accepted" }];

    await expect(
      cancelFamilyInvite(INVITE_ID, PATIENT_A, "patient"),
    ).rejects.toThrow(TRPCError);

    try {
      await cancelFamilyInvite(INVITE_ID, PATIENT_A, "patient");
    } catch (err) {
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    }
  });
});
