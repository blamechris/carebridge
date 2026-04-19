import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSIGNMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_PROVIDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ROLE_IDS: Record<string, string> = {
  nurse: "33333333-3333-4333-8333-333333333333",
  physician: "44444444-4444-4444-8444-444444444444",
  specialist: "55555555-5555-4555-8555-555555555555",
  admin: "66666666-6666-4666-8666-666666666666",
  patient: PATIENT_ID,
  family_caregiver: "77777777-7777-4777-8777-777777777777",
};

// Mock DB — `.limit()` returns arrays FIFO from `limitResults`; the tx mock
// snapshots inserts/updates and rolls them back on throw so the atomicity
// test can observe the rollback contract.

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

  const state: {
    limitResults: unknown[][];
    insertedRows: { table: string; row: Record<string, unknown> }[];
    updatedRows: { table: string; set: Record<string, unknown> }[];
    failTransactionAfterFirstInsert: boolean;
  } = {
    limitResults: [],
    insertedRows: [],
    updatedRows: [],
    failTransactionAfterFirstInsert: false,
  };

  // Default: acting clinician is on the patient's care team. Individual tests
  // override via mockResolvedValueOnce(false) to exercise the FORBIDDEN path.
  // Signature mirrors `middleware/rbac.ts#assertCareTeamAccess`.
  const assertCareTeamAccess = fn(
    async (_userId: string, _patientId: string): Promise<boolean> => true,
  );

  function tableOf(t: unknown): string {
    return (t as { __table?: string })?.__table ?? "unknown";
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.where = fn(() => chain);
    chain.limit = fn(async () => state.limitResults.shift() ?? []);
    return chain;
  }

  function buildHandle(opts: { trackRollback?: boolean } = {}) {
    let firstInsertSeen = false;
    return {
      select: fn(() => makeSelectChain()),
      insert: fn((table: unknown) => ({
        values: fn(async (row: Record<string, unknown>) => {
          state.insertedRows.push({ table: tableOf(table), row });
          if (opts.trackRollback && state.failTransactionAfterFirstInsert) {
            if (!firstInsertSeen) {
              firstInsertSeen = true;
              return;
            }
            throw new Error("simulated RBAC grant failure");
          }
        }),
      })),
      update: fn((table: unknown) => ({
        set: fn((set: Record<string, unknown>) => ({
          where: fn(async () => {
            state.updatedRows.push({ table: tableOf(table), set });
          }),
        })),
      })),
    };
  }

  const mockDb = {
    ...buildHandle(),
    transaction: fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const preInsert = state.insertedRows.length;
      const preUpdate = state.updatedRows.length;
      try {
        return await cb(buildHandle({ trackRollback: true }));
      } catch (err) {
        // Drizzle rolls back on throw — mirror that so tests can assert
        // neither staged row remained committed.
        state.insertedRows.length = preInsert;
        state.updatedRows.length = preUpdate;
        throw err;
      }
    }),
  };

  return { state, mockDb, assertCareTeamAccess };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  careTeamMembers: {
    __table: "care_team_members",
    id: "care_team_members.id",
    patient_id: "care_team_members.patient_id",
    provider_id: "care_team_members.provider_id",
    is_active: "care_team_members.is_active",
  },
  careTeamAssignments: {
    __table: "care_team_assignments",
    id: "care_team_assignments.id",
    user_id: "care_team_assignments.user_id",
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
  },
  auditLog: { __table: "audit_log" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ eq: col, val }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

// Patient-access gate — mocked so individual tests can flip the acting
// clinician's care-team membership on/off without touching the DB mock.
vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: (userId: string, patientId: string) =>
    mocks.assertCareTeamAccess(userId, patientId),
}));

import { careTeamRbacRouter } from "../routers/care-team.js";
import type { Context } from "../context.js";

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

function callerFor(user: User | null) {
  const ctx: Context = {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
    clientIp: null,
  };
  return careTeamRbacRouter.createCaller(ctx);
}

const auditRows = () => mocks.state.insertedRows.filter((r) => r.table === "audit_log");
const memberRows = () => mocks.state.insertedRows.filter((r) => r.table === "care_team_members");
const assignmentRows = () => mocks.state.insertedRows.filter((r) => r.table === "care_team_assignments");

function reset() {
  mocks.state.limitResults = [];
  mocks.state.insertedRows = [];
  mocks.state.updatedRows = [];
  mocks.state.failTransactionAfterFirstInsert = false;
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  // Reset implementation AND drain any leftover `mockResolvedValueOnce`
  // queue. Without this, an admin-bypass test (which never consumes its
  // queued `false`) would poison the NEXT test's first access check.
  mocks.assertCareTeamAccess.mockReset();
  mocks.assertCareTeamAccess.mockImplementation(async () => true);
});

describe("careTeam.addMember", () => {
  const input = {
    patient_id: PATIENT_ID,
    provider_id: TARGET_PROVIDER_ID,
    role: "nurse" as const,
    specialty: "Oncology",
  };

  it("allows physician to add a nurse and writes an audit entry", async () => {
    const result = await callerFor(makeUser("physician")).addMember(input);
    expect(result).toMatchObject({
      patient_id: PATIENT_ID,
      provider_id: TARGET_PROVIDER_ID,
      role: "nurse",
      specialty: "Oncology",
      is_active: true,
    });
    expect(memberRows()).toHaveLength(1);
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.row).toMatchObject({
      user_id: ROLE_IDS.physician,
      action: "care_team_add_member",
      resource_type: "care_team_member",
      patient_id: PATIENT_ID,
    });
    const details = JSON.parse(audit[0]!.row.details as string);
    expect(details.new_value).toMatchObject({
      provider_id: TARGET_PROVIDER_ID,
      role: "nurse",
      specialty: "Oncology",
    });
  });

  it.each([["specialist"], ["admin"]] as const)("allows %s to add a member", async (role) => {
    await expect(callerFor(makeUser(role)).addMember(input)).resolves.toBeDefined();
    expect(memberRows()).toHaveLength(1);
  });

  it.each([["nurse"], ["patient"], ["family_caregiver"]] as const)(
    "rejects %s (FORBIDDEN)",
    async (role) => {
      await expect(callerFor(makeUser(role)).addMember(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(memberRows()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    await expect(callerFor(null).addMember(input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects physician NOT on the patient's care team (FORBIDDEN)", async () => {
    // HIPAA minimum-necessary: role-gate alone isn't enough; the acting
    // clinician must also be on this specific patient's care team.
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(
      callerFor(makeUser("physician")).addMember(input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(memberRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("allows admin regardless of care-team membership (bypass)", async () => {
    // Admin is unrestricted — assertCareTeamAccess must not even be called.
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(callerFor(makeUser("admin")).addMember(input)).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
  });

  it("rolls back the team insert when the atomic RBAC grant fails", async () => {
    mocks.state.failTransactionAfterFirstInsert = true;
    await expect(
      callerFor(makeUser("physician")).addMember({ ...input, assignment_role: "nursing" }),
    ).rejects.toThrow(/simulated RBAC grant failure/);

    // Rollback contract: neither row committed, audit row also rolled back.
    expect(memberRows()).toHaveLength(0);
    expect(assignmentRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("commits team-member and RBAC assignment atomically on success", async () => {
    await expect(
      callerFor(makeUser("physician")).addMember({ ...input, assignment_role: "nursing" }),
    ).resolves.toBeDefined();
    expect(memberRows()).toHaveLength(1);
    expect(assignmentRows()).toHaveLength(1);
    expect(assignmentRows()[0]!.row).toMatchObject({
      user_id: TARGET_PROVIDER_ID,
      patient_id: PATIENT_ID,
      role: "nursing",
    });
  });

  // Issue #883 — capture the RBAC assignment_id in the audit row's
  // structured details so auditors can correlate the team-member insert
  // with the access-grant it triggered.
  it("records the new assignment_id in audit details when RBAC grant is paired", async () => {
    await callerFor(makeUser("physician")).addMember({
      ...input,
      assignment_role: "nursing",
    });
    const audit = auditRows();
    expect(audit).toHaveLength(1);
    const details = JSON.parse(audit[0]!.row.details as string);
    expect(details.new_value.assignment_id).toEqual(expect.any(String));
    // Must match the actual committed assignment row's id.
    expect(details.new_value.assignment_id).toBe(assignmentRows()[0]!.row.id);
    expect(details.new_value.assignment_role).toBe("nursing");
  });

  it("omits assignment_id from audit details when no RBAC grant is paired", async () => {
    await callerFor(makeUser("physician")).addMember(input);
    const details = JSON.parse(auditRows()[0]!.row.details as string);
    // assignment_id must only be present when an assignment was actually
    // inserted — a stray field would mislead auditors.
    expect(details.new_value.assignment_id).toBeUndefined();
  });

  // Issue #881 — idempotency: a duplicate add for an already-active
  // (provider_id, patient_id) pair returns the existing row and writes
  // NO new state (no member insert, no audit row).
  describe("idempotency (#881)", () => {
    const existingMember = {
      id: MEMBER_ID,
      patient_id: PATIENT_ID,
      provider_id: TARGET_PROVIDER_ID,
      role: "nurse",
      specialty: "Oncology",
      is_active: true,
      started_at: "2026-04-16T00:00:00.000Z",
      created_at: "2026-04-16T00:00:00.000Z",
    };

    it("returns the existing active row and writes no new state", async () => {
      mocks.state.limitResults = [[existingMember]];
      const result = await callerFor(makeUser("physician")).addMember(input);
      expect(result).toMatchObject({
        id: MEMBER_ID,
        provider_id: TARGET_PROVIDER_ID,
        patient_id: PATIENT_ID,
        is_active: true,
      });
      // No new member row, no new assignment row, no audit row.
      expect(memberRows()).toHaveLength(0);
      expect(assignmentRows()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it("is idempotent even when an assignment_role is supplied", async () => {
      mocks.state.limitResults = [[existingMember]];
      const result = await callerFor(makeUser("physician")).addMember({
        ...input,
        assignment_role: "nursing",
      });
      expect(result).toMatchObject({ id: MEMBER_ID });
      expect(memberRows()).toHaveLength(0);
      expect(assignmentRows()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  });
});

describe("careTeam.removeMember (soft delete)", () => {
  const existing = {
    id: MEMBER_ID,
    patient_id: PATIENT_ID,
    provider_id: TARGET_PROVIDER_ID,
    role: "nurse",
    specialty: "Oncology",
    is_active: true,
  };

  it("soft-deletes the member (is_active=false, ended_at set) and audits", async () => {
    mocks.state.limitResults = [[existing]];
    const result = await callerFor(makeUser("physician")).removeMember({ member_id: MEMBER_ID });

    expect(result).toMatchObject({ removed: true, member_id: MEMBER_ID });
    expect(mocks.state.updatedRows).toHaveLength(1);
    expect(mocks.state.updatedRows[0]!.table).toBe("care_team_members");
    expect(mocks.state.updatedRows[0]!.set).toMatchObject({ is_active: false });
    expect(mocks.state.updatedRows[0]!.set.ended_at).toEqual(expect.any(String));
    expect(auditRows()[0]!.row).toMatchObject({
      action: "care_team_remove_member",
      resource_id: MEMBER_ID,
      patient_id: PATIENT_ID,
    });
  });

  it("rejects nurse (FORBIDDEN)", async () => {
    await expect(
      callerFor(makeUser("nurse")).removeMember({ member_id: MEMBER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
  });

  it("returns NOT_FOUND when the member does not exist", async () => {
    mocks.state.limitResults = [[]];
    await expect(
      callerFor(makeUser("physician")).removeMember({ member_id: MEMBER_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects physician NOT on the patient's care team (FORBIDDEN)", async () => {
    mocks.state.limitResults = [[existing]];
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(
      callerFor(makeUser("physician")).removeMember({ member_id: MEMBER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  // Issue #881 — REST idempotent DELETE: removing an already-inactive
  // member is a 200 no-op, not an error. The original `ended_at` is
  // preserved (not overwritten) so the audit trail of WHEN the member
  // was removed remains trustworthy.
  describe("idempotency (#881) — already inactive", () => {
    const originalEndedAt = "2026-04-15T10:00:00.000Z";
    const alreadyRemoved = {
      id: MEMBER_ID,
      patient_id: PATIENT_ID,
      provider_id: TARGET_PROVIDER_ID,
      role: "nurse",
      specialty: "Oncology",
      is_active: false,
      ended_at: originalEndedAt,
    };

    it("no-ops when the member is already inactive (preserves ended_at, no audit row)", async () => {
      mocks.state.limitResults = [[alreadyRemoved]];
      const result = await callerFor(makeUser("physician")).removeMember({
        member_id: MEMBER_ID,
      });
      expect(result).toMatchObject({ removed: true, member_id: MEMBER_ID });
      // Critical: no UPDATE may run, so the original ended_at is preserved.
      expect(mocks.state.updatedRows).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  });
});

describe("careTeam.updateRole", () => {
  const existing = {
    id: MEMBER_ID,
    patient_id: PATIENT_ID,
    provider_id: TARGET_PROVIDER_ID,
    role: "nurse",
    specialty: "Oncology",
    is_active: true,
  };

  it("updates role+specialty and captures old/new values in audit", async () => {
    mocks.state.limitResults = [[existing]];
    const result = await callerFor(makeUser("physician")).updateRole({
      member_id: MEMBER_ID,
      role: "coordinator",
      specialty: "Care Coordination",
    });

    expect(result).toMatchObject({
      member_id: MEMBER_ID,
      role: "coordinator",
      specialty: "Care Coordination",
    });
    expect(mocks.state.updatedRows[0]!.set).toMatchObject({
      role: "coordinator",
      specialty: "Care Coordination",
    });
    const details = JSON.parse(auditRows()[0]!.row.details as string);
    expect(details.old_value).toMatchObject({ role: "nurse", specialty: "Oncology" });
    expect(details.new_value).toMatchObject({
      role: "coordinator",
      specialty: "Care Coordination",
    });
  });

  it("rejects nurse (FORBIDDEN)", async () => {
    await expect(
      callerFor(makeUser("nurse")).updateRole({ member_id: MEMBER_ID, role: "coordinator" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
  });

  it("returns NOT_FOUND when the member does not exist", async () => {
    mocks.state.limitResults = [[]];
    await expect(
      callerFor(makeUser("physician")).updateRole({ member_id: MEMBER_ID, role: "coordinator" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects physician NOT on the patient's care team (FORBIDDEN)", async () => {
    mocks.state.limitResults = [[existing]];
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(
      callerFor(makeUser("physician")).updateRole({ member_id: MEMBER_ID, role: "coordinator" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });
});

describe("careTeam.assignments.grant", () => {
  const input = {
    user_id: TARGET_PROVIDER_ID,
    patient_id: PATIENT_ID,
    role: "attending" as const,
  };

  it("allows physician to grant an assignment and writes audit", async () => {
    const result = await callerFor(makeUser("physician")).assignments.grant(input);
    expect(result).toMatchObject(input);
    expect(assignmentRows()).toHaveLength(1);
    expect(auditRows()[0]!.row).toMatchObject({
      action: "care_team_grant_assignment",
      resource_type: "care_team_assignment",
      patient_id: PATIENT_ID,
    });
  });

  it.each([["nurse"], ["patient"]] as const)("rejects %s (FORBIDDEN)", async (role) => {
    await expect(
      callerFor(makeUser(role)).assignments.grant(input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(assignmentRows()).toHaveLength(0);
  });

  it("rejects physician NOT on the patient's care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(
      callerFor(makeUser("physician")).assignments.grant(input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(assignmentRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  // Issue #881 — grant is idempotent on (user_id, patient_id). Second
  // grant for an already-active assignment returns the existing row and
  // writes no new state.
  describe("idempotency (#881)", () => {
    const existingAssignment = {
      id: ASSIGNMENT_ID,
      user_id: TARGET_PROVIDER_ID,
      patient_id: PATIENT_ID,
      role: "attending",
      assigned_at: "2026-04-16T00:00:00.000Z",
      removed_at: null,
    };

    it("returns the existing active assignment and writes no new state", async () => {
      mocks.state.limitResults = [[existingAssignment]];
      const result = await callerFor(makeUser("physician")).assignments.grant(input);
      expect(result).toMatchObject({
        id: ASSIGNMENT_ID,
        user_id: TARGET_PROVIDER_ID,
        patient_id: PATIENT_ID,
      });
      expect(assignmentRows()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  });
});

describe("careTeam.assignments.revoke", () => {
  const existing = {
    id: ASSIGNMENT_ID,
    user_id: TARGET_PROVIDER_ID,
    patient_id: PATIENT_ID,
    role: "attending",
    removed_at: null,
  };

  it("soft-deletes the assignment (sets removed_at) and audits", async () => {
    mocks.state.limitResults = [[existing]];
    const result = await callerFor(makeUser("physician")).assignments.revoke({
      assignment_id: ASSIGNMENT_ID,
    });
    expect(result).toMatchObject({ revoked: true, assignment_id: ASSIGNMENT_ID });
    expect(mocks.state.updatedRows[0]!.table).toBe("care_team_assignments");
    expect(mocks.state.updatedRows[0]!.set).toMatchObject({ removed_at: expect.any(String) });
    expect(auditRows()[0]!.row).toMatchObject({
      action: "care_team_revoke_assignment",
      resource_id: ASSIGNMENT_ID,
      patient_id: PATIENT_ID,
    });
  });

  it("rejects nurse (FORBIDDEN)", async () => {
    await expect(
      callerFor(makeUser("nurse")).assignments.revoke({ assignment_id: ASSIGNMENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
  });

  it("returns NOT_FOUND when the assignment does not exist", async () => {
    mocks.state.limitResults = [[]];
    await expect(
      callerFor(makeUser("physician")).assignments.revoke({ assignment_id: ASSIGNMENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // Issue #881 — revoking an already-revoked assignment is a 200 no-op.
  // Preserves the original `removed_at` (do NOT overwrite) so auditors
  // can trust WHEN access was actually revoked.
  it("no-ops when the assignment is already revoked (preserves removed_at)", async () => {
    const originalRemovedAt = "2026-04-15T10:00:00.000Z";
    mocks.state.limitResults = [[
      {
        id: ASSIGNMENT_ID,
        user_id: TARGET_PROVIDER_ID,
        patient_id: PATIENT_ID,
        role: "attending",
        removed_at: originalRemovedAt,
      },
    ]];
    const result = await callerFor(makeUser("physician")).assignments.revoke({
      assignment_id: ASSIGNMENT_ID,
    });
    expect(result).toMatchObject({ revoked: true, assignment_id: ASSIGNMENT_ID });
    expect(mocks.state.updatedRows).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    await expect(
      callerFor(null).assignments.revoke({ assignment_id: ASSIGNMENT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects physician NOT on the patient's care team (FORBIDDEN)", async () => {
    mocks.state.limitResults = [[existing]];
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    await expect(
      callerFor(makeUser("physician")).assignments.revoke({ assignment_id: ASSIGNMENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.state.updatedRows).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });
});
