import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

/**
 * RBAC coverage for the scheduling router. Locks in the HIPAA patient-
 * ownership check on appointments.create / appointments.cancel that was
 * missing prior to the security-review finding on PR #890.
 *
 * Test matrix per mutation:
 *   patient          self vs cross-patient
 *   physician/nurse  on-care-team vs off-care-team
 *   specialist       same
 *   admin            unrestricted
 *   family_caregiver active link vs revoked/no link
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const OTHER_PATIENT_RECORD_ID = "bbbb2222-2222-4222-8222-222222222222";
const PATIENT_USER_ID = "11110000-0000-4000-8000-000000000001";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const NURSE_ID = "33333333-3333-4333-8333-333333333333";
const SPECIALIST_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_ID = "66666666-6666-4666-8666-666666666666";
const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";

const APPOINTMENT_ID = "cccc3333-3333-4333-8333-333333333333";

const BOOK_INPUT = {
  providerId: PROVIDER_ID,
  appointmentType: "follow_up" as const,
  startTime: "2026-05-01T15:00:00.000Z",
  endTime: "2026-05-01T15:30:00.000Z",
  location: "Main Clinic",
  reason: "follow-up",
};

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so they're available when vi.mock factories fire
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

  // Stateful db mock. Each query chain pulls from `state.queue` in order
  // (first `.limit()`/`.where()` resolve returns queue[0], next pulls
  // queue[1], etc). Falls back to `state.default`. Resetting per-test in
  // beforeEach keeps the ordering deterministic.
  const state: { queue: unknown[][]; default: unknown[] } = {
    queue: [],
    default: [],
  };

  function nextResult(): unknown[] {
    if (state.queue.length > 0) return state.queue.shift()!;
    return state.default;
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.innerJoin = fn(() => chain);
    // .where can either be terminal (awaited directly) or chained with
    // .orderBy / .limit — make the return thenable AND chainable.
    chain.where = fn(() => {
      const result: Record<string | symbol, unknown> = {
        orderBy: fn(async () => nextResult()),
        limit: fn(async () => nextResult()),
      };
      (result as { then: (resolve: (v: unknown) => void) => unknown }).then = (
        resolve,
      ) => {
        resolve(nextResult());
        return result;
      };
      return result;
    });
    chain.orderBy = fn(async () => nextResult());
    chain.limit = fn(async () => nextResult());
    return chain;
  }

  const insertFn = fn(() => ({ values: fn(async () => undefined) }));

  // db.transaction(cb) — invokes cb with a tx object that mimics select/insert.
  const transactionFn = fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx: Record<string, unknown> = {
      select: fn(() => makeSelectChain()),
      insert: insertFn,
    };
    return cb(tx);
  });

  return {
    state,
    makeSelectChain,
    insertFn,
    transactionFn,
    assertCareTeamAccess: fn(async () => true),
    mockDb: {
      select: fn(() => makeSelectChain()),
      insert: insertFn,
      update: fn(() => ({ set: fn(() => ({ where: fn(async () => undefined) })) })),
      transaction: transactionFn,
    },
  };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  appointments: {
    id: "appointments.id",
    patient_id: "appointments.patient_id",
    provider_id: "appointments.provider_id",
    start_time: "appointments.start_time",
    end_time: "appointments.end_time",
    status: "appointments.status",
  },
  providerSchedules: {
    id: "provider_schedules.id",
    provider_id: "provider_schedules.provider_id",
    day_of_week: "provider_schedules.day_of_week",
    is_active: "provider_schedules.is_active",
  },
  scheduleBlocks: {
    id: "schedule_blocks.id",
    provider_id: "schedule_blocks.provider_id",
    start_time: "schedule_blocks.start_time",
    end_time: "schedule_blocks.end_time",
  },
  familyRelationships: {
    id: "family_relationships.id",
    patient_id: "family_relationships.patient_id",
    caregiver_id: "family_relationships.caregiver_id",
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
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  ne: (col: unknown, val: unknown) => ({ op: "ne", col, val }),
  desc: (col: unknown) => ({ op: "desc", col }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: mocks.assertCareTeamAccess,
}));

import { schedulingRbacRouter } from "../routers/scheduling.js";
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(user: User | null): Context {
  return {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
    clientIp: null,
  };
}

function callerFor(user: User | null) {
  return schedulingRbacRouter.createCaller(makeContext(user));
}

// ---------------------------------------------------------------------------
// appointments.create
// ---------------------------------------------------------------------------

describe("schedulingRbacRouter.appointments.create — patient-ownership enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.queue = [];
    mocks.state.default = [];
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
  });

  it("rejects unauthenticated callers", async () => {
    const caller = callerFor(null);
    await expect(
      caller.appointments.create({ ...BOOK_INPUT, patientId: PATIENT_RECORD_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  // --- patient role ------------------------------------------------------

  it("allows a patient to book against their own patient_id", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // tx.select overlapping appointments -> empty (no conflict)
    mocks.state.queue = [[]];
    const result = await callerFor(patient).appointments.create({
      ...BOOK_INPUT,
      patientId: PATIENT_RECORD_ID,
    });
    expect(result).toMatchObject({ patient_id: PATIENT_RECORD_ID });
  });

  it("defaults patient_id from ctx.user.patient_id when omitted", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    mocks.state.queue = [[]];
    const result = await callerFor(patient).appointments.create(BOOK_INPUT);
    expect(result).toMatchObject({ patient_id: PATIENT_RECORD_ID });
  });

  it("rejects a patient booking against a different patient_id (FORBIDDEN)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      callerFor(patient).appointments.create({
        ...BOOK_INPUT,
        patientId: OTHER_PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Never enters the transaction / insert path
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  // --- clinician roles (physician / nurse / specialist) ------------------

  it("allows a physician on the care team to book for a patient", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
    const physician = makeUser("physician", PROVIDER_ID);
    mocks.state.queue = [[]];
    const result = await callerFor(physician).appointments.create({
      ...BOOK_INPUT,
      patientId: PATIENT_RECORD_ID,
    });
    expect(result).toMatchObject({ patient_id: PATIENT_RECORD_ID });
    expect(mocks.assertCareTeamAccess).toHaveBeenCalledWith(
      PROVIDER_ID,
      PATIENT_RECORD_ID,
    );
  });

  it("rejects a physician NOT on the care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const physician = makeUser("physician", PROVIDER_ID);
    await expect(
      callerFor(physician).appointments.create({
        ...BOOK_INPUT,
        patientId: PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it("rejects a nurse NOT on the care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const nurse = makeUser("nurse", NURSE_ID);
    await expect(
      callerFor(nurse).appointments.create({
        ...BOOK_INPUT,
        patientId: PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a specialist NOT on the care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const specialist = makeUser("specialist", SPECIALIST_ID);
    await expect(
      callerFor(specialist).appointments.create({
        ...BOOK_INPUT,
        patientId: PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects clinician create when patientId is missing (BAD_REQUEST)", async () => {
    const physician = makeUser("physician", PROVIDER_ID);
    await expect(
      callerFor(physician).appointments.create(BOOK_INPUT),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // --- admin -------------------------------------------------------------

  it("allows an admin to book cross-patient (unrestricted)", async () => {
    const admin = makeUser("admin", ADMIN_ID);
    mocks.state.queue = [[]];
    const result = await callerFor(admin).appointments.create({
      ...BOOK_INPUT,
      patientId: OTHER_PATIENT_RECORD_ID,
    });
    expect(result).toMatchObject({ patient_id: OTHER_PATIENT_RECORD_ID });
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
  });

  // --- family_caregiver --------------------------------------------------

  it("allows a family_caregiver with an active relationship to book", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    // Queue: [hasActiveFamilyLink row exists, overlapping check empty]
    mocks.state.queue = [[{ id: "rel-1" }], []];
    const result = await callerFor(caregiver).appointments.create({
      ...BOOK_INPUT,
      patientId: PATIENT_RECORD_ID,
    });
    expect(result).toMatchObject({ patient_id: PATIENT_RECORD_ID });
  });

  it("rejects a family_caregiver with no active relationship (FORBIDDEN)", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    // Queue: hasActiveFamilyLink -> empty (no row found)
    mocks.state.queue = [[]];
    await expect(
      callerFor(caregiver).appointments.create({
        ...BOOK_INPUT,
        patientId: PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// appointments.cancel
// ---------------------------------------------------------------------------

describe("schedulingRbacRouter.appointments.cancel — patient-ownership enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.queue = [];
    mocks.state.default = [];
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
  });

  it("rejects unauthenticated callers", async () => {
    await expect(
      callerFor(null).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "conflict",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns NOT_FOUND for a missing appointment id", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    mocks.state.queue = [[]];
    await expect(
      callerFor(patient).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "conflict",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  // --- patient role ------------------------------------------------------

  it("allows a patient to cancel their own appointment", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // Lookup returns the target appointment, patient_id matches
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }]];
    const result = await callerFor(patient).appointments.cancel({
      appointmentId: APPOINTMENT_ID,
      reason: "changed plans",
    });
    expect(result).toEqual({ success: true });
    expect(mocks.mockDb.update).toHaveBeenCalled();
  });

  it("rejects a patient cancelling another patient's appointment (FORBIDDEN)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // Appointment belongs to OTHER_PATIENT_RECORD_ID
    mocks.state.queue = [[{ patient_id: OTHER_PATIENT_RECORD_ID }]];
    await expect(
      callerFor(patient).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "malicious",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  // --- clinician roles ---------------------------------------------------

  it("allows a physician on the care team to cancel", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
    const physician = makeUser("physician", PROVIDER_ID);
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }]];
    const result = await callerFor(physician).appointments.cancel({
      appointmentId: APPOINTMENT_ID,
      reason: "reschedule",
    });
    expect(result).toEqual({ success: true });
    expect(mocks.assertCareTeamAccess).toHaveBeenCalledWith(
      PROVIDER_ID,
      PATIENT_RECORD_ID,
    );
  });

  it("rejects a physician NOT on the care team from cancelling (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const physician = makeUser("physician", PROVIDER_ID);
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }]];
    await expect(
      callerFor(physician).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "unauthorised",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects a nurse NOT on the care team from cancelling (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const nurse = makeUser("nurse", NURSE_ID);
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }]];
    await expect(
      callerFor(nurse).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "unauthorised",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // --- admin -------------------------------------------------------------

  it("allows an admin to cancel any appointment (unrestricted)", async () => {
    const admin = makeUser("admin", ADMIN_ID);
    mocks.state.queue = [[{ patient_id: OTHER_PATIENT_RECORD_ID }]];
    const result = await callerFor(admin).appointments.cancel({
      appointmentId: APPOINTMENT_ID,
      reason: "admin override",
    });
    expect(result).toEqual({ success: true });
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
  });

  // --- family_caregiver --------------------------------------------------

  it("allows a family_caregiver with an active relationship to cancel", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    // Queue: [appointment lookup, hasActiveFamilyLink row]
    mocks.state.queue = [
      [{ patient_id: PATIENT_RECORD_ID }],
      [{ id: "rel-1" }],
    ];
    const result = await callerFor(caregiver).appointments.cancel({
      appointmentId: APPOINTMENT_ID,
      reason: "conflict",
    });
    expect(result).toEqual({ success: true });
  });

  it("rejects a family_caregiver with no active relationship from cancelling (FORBIDDEN)", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    // Queue: [appointment lookup, hasActiveFamilyLink empty]
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }], []];
    await expect(
      callerFor(caregiver).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "attempted",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// appointments.listByPatient — smoke coverage so the refactored access
// path stays consistent with create/cancel. Not exhaustive — the deeper
// role matrix is covered by create/cancel above.
// ---------------------------------------------------------------------------

describe("schedulingRbacRouter.appointments.listByPatient — access alignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.queue = [];
    mocks.state.default = [];
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
  });

  it("allows a patient to list their own appointments (patient_id match)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    mocks.state.default = [];
    await expect(
      callerFor(patient).appointments.listByPatient({
        patientId: PATIENT_RECORD_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a patient listing another patient's appointments (FORBIDDEN)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      callerFor(patient).appointments.listByPatient({
        patientId: OTHER_PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a clinician NOT on the care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const physician = makeUser("physician", PROVIDER_ID);
    await expect(
      callerFor(physician).appointments.listByPatient({
        patientId: PATIENT_RECORD_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
