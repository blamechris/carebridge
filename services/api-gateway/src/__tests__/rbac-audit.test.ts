import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @carebridge/db-schema before importing the middleware
// ---------------------------------------------------------------------------

const insertedRows: Record<string, unknown>[] = [];
const mockValues = vi.fn((row: Record<string, unknown>) => {
  insertedRows.push(row);
  return Promise.resolve();
});
const mockInsert = vi.fn(() => ({ values: mockValues }));

// Care-team query: returns empty by default (no assignment)
let careTeamRows: unknown[] = [];
let emergencyAccessRows: unknown[] = [];

let selectCallCount = 0;
function makeSelectChain() {
  const callIndex = selectCallCount++;
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => (callIndex === 0 ? careTeamRows : emergencyAccessRows));
  return chain;
}

const mockDb = {
  insert: mockInsert,
  select: vi.fn(() => makeSelectChain()),
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  auditLog: { __table: "audit_log" },
  careTeamAssignments: {
    id: "care_team_assignments.id",
    user_id: "care_team_assignments.user_id",
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
  },
  emergencyAccess: {
    id: "emergency_access.id",
    user_id: "emergency_access.user_id",
    patient_id: "emergency_access.patient_id",
    revoked_at: "emergency_access.revoked_at",
    expires_at: "emergency_access.expires_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...args: unknown[]) => args,
  isNull: (col: unknown) => ({ isNull: col }),
  gt: (col: unknown, val: unknown) => ({ gt: col, val }),
}));

import { assertPatientAccess } from "../middleware/rbac.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(user?: Record<string, unknown>) {
  return {
    ip: "127.0.0.1",
    log: { error: vi.fn() },
    ...(user ? { user } : {}),
  } as unknown as Parameters<typeof assertPatientAccess>[0];
}

function makeReply() {
  const reply: Record<string, unknown> = {};
  reply.code = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply as unknown as Parameters<typeof assertPatientAccess>[1];
}

const patientUser = {
  id: "patient-1",
  email: "patient@carebridge.dev",
  name: "Test Patient",
  role: "patient",
  is_active: true,
};

const physicianUser = {
  id: "doc-1",
  email: "dr.smith@carebridge.dev",
  name: "Dr. Smith",
  role: "physician",
  specialty: "Hematology/Oncology",
  is_active: true,
};

const adminUser = {
  id: "admin-1",
  email: "admin@carebridge.dev",
  name: "Admin",
  role: "admin",
  is_active: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RBAC audit logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRows.length = 0;
    careTeamRows = [];
    emergencyAccessRows = [];
    selectCallCount = 0;
  });

  it("logs an audit entry when a patient accesses another patient's data", async () => {
    const request = makeRequest(patientUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "patient-other");

    expect(result).toBe(false);
    expect((reply as unknown as Record<string, unknown>).code).toHaveBeenCalledWith(403);

    // Verify audit log was inserted
    expect(mockInsert).toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);

    const entry = insertedRows[0]!;
    expect(entry.user_id).toBe("patient-1");
    expect(entry.action).toBe("access_denied");
    expect(entry.resource_type).toBe("rbac");
    expect(entry.ip_address).toBe("127.0.0.1");

    const details = JSON.parse(entry.details as string);
    expect(details.reason).toBe("patient_access_denied");
    expect(details.requested_patient_id).toBe("patient-other");
    expect(details.role).toBe("patient");
  });

  it("logs an audit entry when a clinician has no care-team assignment", async () => {
    careTeamRows = []; // No assignment found
    const request = makeRequest(physicianUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "patient-99");

    expect(result).toBe(false);
    expect((reply as unknown as Record<string, unknown>).code).toHaveBeenCalledWith(403);

    // Verify audit log was inserted
    expect(mockInsert).toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);

    const entry = insertedRows[0]!;
    expect(entry.user_id).toBe("doc-1");
    expect(entry.action).toBe("access_denied");
    expect(entry.resource_type).toBe("rbac");

    const details = JSON.parse(entry.details as string);
    expect(details.reason).toBe("care_team_not_assigned");
    expect(details.requested_patient_id).toBe("patient-99");
    expect(details.role).toBe("physician");
  });

  it("does NOT log an audit entry when a patient accesses their own data", async () => {
    const request = makeRequest(patientUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "patient-1");

    expect(result).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it("does NOT log an audit entry for admin access", async () => {
    const request = makeRequest(adminUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "any-patient");

    expect(result).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does NOT log an audit entry when a clinician has a valid care-team assignment", async () => {
    careTeamRows = [{ id: "assignment-1" }]; // Active assignment exists
    const request = makeRequest(physicianUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "patient-1");

    expect(result).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does not crash the request if audit logging fails", async () => {
    mockInsert.mockImplementationOnce(() => ({
      values: vi.fn(() => Promise.reject(new Error("DB connection lost"))),
    }));

    const request = makeRequest(patientUser);
    const reply = makeReply();

    const result = await assertPatientAccess(request, reply, "patient-other");

    // The access denial still completes normally
    expect(result).toBe(false);
    expect((reply as unknown as Record<string, unknown>).code).toHaveBeenCalledWith(403);

    // Error was logged, not thrown
    expect(
      (request as unknown as Record<string, { error: ReturnType<typeof vi.fn> }>).log.error,
    ).toHaveBeenCalled();
  });
});
