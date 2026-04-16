/**
 * Gateway-layer RBAC tests for the family-access tRPC router.
 *
 * The service layer ("@carebridge/auth/family-invite-flow") is covered by
 * ~35 cases in services/auth. These tests verify the router's role gate
 * and that it forwards inputs correctly to the service layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_IDS: Record<string, string> = {
  nurse: "33333333-3333-4333-8333-333333333333",
  physician: "44444444-4444-4444-8444-444444444444",
  specialist: "55555555-5555-4555-8555-555555555555",
  admin: "66666666-6666-4666-8666-666666666666",
  patient: PATIENT_ID,
  family_caregiver: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => ({
  createFamilyInvite: vi.fn(async () => ({ id: "invite-1", token: "tok-1" })),
  acceptFamilyInvite: vi.fn(async () => ({
    id: "rel-1",
    status: "active" as const,
  })),
  revokeFamilyAccess: vi.fn(async () => undefined),
  cancelFamilyInvite: vi.fn(async () => undefined),
  listFamilyRelationships: vi.fn(async () => []),
  listFamilyInvites: vi.fn(async () => []),
}));

vi.mock("@carebridge/auth/family-invite-flow", () => ({
  createFamilyInvite: mocks.createFamilyInvite,
  acceptFamilyInvite: mocks.acceptFamilyInvite,
  revokeFamilyAccess: mocks.revokeFamilyAccess,
  cancelFamilyInvite: mocks.cancelFamilyInvite,
  listFamilyRelationships: mocks.listFamilyRelationships,
  listFamilyInvites: mocks.listFamilyInvites,
}));

import { familyAccessRbacRouter } from "../routers/family-access.js";
import type { Context } from "../context.js";

function makeUser(role: User["role"], id = ROLE_IDS[role]!): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function callerFor(user: User | null) {
  const ctx: Context = {
    db: {} as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
  };
  return familyAccessRbacRouter.createCaller(ctx);
}

const inviteInput = {
  invitee_email: "caregiver@example.com",
  relationship_type: "spouse" as const,
};

describe("familyAccessRbacRouter — createInvite RBAC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a patient to create an invite", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(caller.createInvite(inviteInput)).resolves.toBeDefined();
    expect(mocks.createFamilyInvite).toHaveBeenCalledWith(
      PATIENT_ID,
      "caregiver@example.com",
      "spouse",
    );
  });

  it("denies a physician (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(caller.createInvite(inviteInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createFamilyInvite).not.toHaveBeenCalled();
  });

  it("denies a nurse (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.createInvite(inviteInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createFamilyInvite).not.toHaveBeenCalled();
  });

  it("denies an admin (FORBIDDEN) — only patients invite", async () => {
    const caller = callerFor(makeUser("admin"));
    await expect(caller.createInvite(inviteInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("denies a family_caregiver (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("family_caregiver" as User["role"]));
    await expect(caller.createInvite(inviteInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(caller.createInvite(inviteInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("validates invitee_email shape", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.createInvite({
        invitee_email: "not-an-email",
        relationship_type: "spouse",
      }),
    ).rejects.toBeDefined();
    expect(mocks.createFamilyInvite).not.toHaveBeenCalled();
  });

  it("rejects unknown relationship_type values", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.createInvite({
        invitee_email: "caregiver@example.com",
        relationship_type: "healthcare_poa" as never,
      }),
    ).rejects.toBeDefined();
    expect(mocks.createFamilyInvite).not.toHaveBeenCalled();
  });
});

describe("familyAccessRbacRouter — acceptInvite", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the token and accepting user.id to the service", async () => {
    const caller = callerFor(makeUser("family_caregiver" as User["role"]));
    await caller.acceptInvite({ invite_token: "tok-abc" });
    expect(mocks.acceptFamilyInvite).toHaveBeenCalledWith(
      "tok-abc",
      ROLE_IDS.family_caregiver,
    );
  });

  it("allows accept from any authenticated role (role check is on create)", async () => {
    for (const role of ["patient", "physician", "nurse", "admin"] as const) {
      const caller = callerFor(makeUser(role));
      await expect(
        caller.acceptInvite({ invite_token: "tok-abc" }),
      ).resolves.toBeDefined();
    }
    expect(mocks.acceptFamilyInvite).toHaveBeenCalledTimes(4);
  });

  it("rejects empty token via input schema", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.acceptInvite({ invite_token: "" }),
    ).rejects.toBeDefined();
    expect(mocks.acceptFamilyInvite).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(
      caller.acceptInvite({ invite_token: "tok-abc" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("familyAccessRbacRouter — revokeAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards relationship_id, user.id, user.role to the service", async () => {
    const caller = callerFor(makeUser("patient"));
    await caller.revokeAccess({ relationship_id: ROLE_IDS.family_caregiver });
    expect(mocks.revokeFamilyAccess).toHaveBeenCalledWith(
      ROLE_IDS.family_caregiver,
      PATIENT_ID,
      "patient",
    );
  });

  it("returns { revoked: true } on success", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.revokeAccess({ relationship_id: ROLE_IDS.family_caregiver }),
    ).resolves.toEqual({ revoked: true });
  });

  it("rejects non-UUID relationship_id", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.revokeAccess({ relationship_id: "not-a-uuid" }),
    ).rejects.toBeDefined();
    expect(mocks.revokeFamilyAccess).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(
      caller.revokeAccess({ relationship_id: ROLE_IDS.family_caregiver }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("familyAccessRbacRouter — cancelInvite", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards invite_id, user.id, user.role to the service", async () => {
    const caller = callerFor(makeUser("patient"));
    await caller.cancelInvite({ invite_id: ROLE_IDS.family_caregiver });
    expect(mocks.cancelFamilyInvite).toHaveBeenCalledWith(
      ROLE_IDS.family_caregiver,
      PATIENT_ID,
      "patient",
    );
  });

  it("returns { cancelled: true } on success", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.cancelInvite({ invite_id: ROLE_IDS.family_caregiver }),
    ).resolves.toEqual({ cancelled: true });
  });

  it("rejects non-UUID invite_id", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(
      caller.cancelInvite({ invite_id: "not-a-uuid" }),
    ).rejects.toBeDefined();
    expect(mocks.cancelFamilyInvite).not.toHaveBeenCalled();
  });
});

describe("familyAccessRbacRouter — listRelationships RBAC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a patient to list their own relationships", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(caller.listRelationships()).resolves.toEqual([]);
    expect(mocks.listFamilyRelationships).toHaveBeenCalledWith(PATIENT_ID);
  });

  it("allows an admin", async () => {
    const caller = callerFor(makeUser("admin"));
    await expect(caller.listRelationships()).resolves.toEqual([]);
    expect(mocks.listFamilyRelationships).toHaveBeenCalledWith(ROLE_IDS.admin);
  });

  it("denies a physician (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(caller.listRelationships()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.listFamilyRelationships).not.toHaveBeenCalled();
  });

  it("denies a family_caregiver (FORBIDDEN) — caregivers list via their own view", async () => {
    const caller = callerFor(makeUser("family_caregiver" as User["role"]));
    await expect(caller.listRelationships()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects unauthenticated caller (UNAUTHORIZED)", async () => {
    const caller = callerFor(null);
    await expect(caller.listRelationships()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("familyAccessRbacRouter — listInvites RBAC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a patient", async () => {
    const caller = callerFor(makeUser("patient"));
    await expect(caller.listInvites()).resolves.toEqual([]);
    expect(mocks.listFamilyInvites).toHaveBeenCalledWith(PATIENT_ID);
  });

  it("allows an admin", async () => {
    const caller = callerFor(makeUser("admin"));
    await expect(caller.listInvites()).resolves.toEqual([]);
  });

  it("denies nurse, specialist, physician, family_caregiver", async () => {
    for (const role of [
      "nurse",
      "specialist",
      "physician",
      "family_caregiver",
    ] as const) {
      const caller = callerFor(makeUser(role as User["role"]));
      await expect(caller.listInvites()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });
});
