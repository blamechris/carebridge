/**
 * Tests for family access ownership validation (issue #305).
 *
 * Verifies that revokeFamilyAccess and cancelFamilyInvite reject
 * callers who do not own the target relationship/invite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// ---------------------------------------------------------------------------
// Mock @carebridge/db-schema
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let relationshipRows: Row[] = [];
let inviteRows: Row[] = [];
const insertedRows: Row[] = [];
const updatedSets: Row[] = [];

function makeSelectChain(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  (chain as { then?: unknown }).then = (onFulfilled: (r: Row[]) => unknown) =>
    Promise.resolve(rows).then(onFulfilled);
  return chain;
}

let selectTarget: "relationships" | "invites" = "relationships";

const mockDb = {
  select: vi.fn(() => {
    const target = selectTarget;
    return makeSelectChain(target === "relationships" ? relationshipRows : inviteRows);
  }),
  insert: vi.fn(() => ({
    values: vi.fn((row: Row) => {
      insertedRows.push(row);
      return Promise.resolve();
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn((row: Row) => ({
      where: vi.fn(() => {
        updatedSets.push(row);
        return Promise.resolve();
      }),
    })),
  })),
};

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

beforeEach(() => {
  vi.clearAllMocks();
  relationshipRows = [];
  inviteRows = [];
  insertedRows.length = 0;
  updatedSets.length = 0;
  selectTarget = "relationships";
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
