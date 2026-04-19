import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

/**
 * Coverage for the atomic reschedule procedure (#892) and the
 * server-side cancel-reason validation (#893).
 *
 * Reschedule runs cancel+book inside a single `db.transaction`. The mock
 * exposed by `mocks.transactionFn` routes the select/insert/update chain
 * into `makeSelectChain()` / `insertFn` / `updateFn` so the test can
 * assert rollback behaviour (the transaction callback must throw on
 * conflict / forbidden, leaving the old appointment untouched).
 */

const PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const OTHER_PATIENT_RECORD_ID = "bbbb2222-2222-4222-8222-222222222222";
const PATIENT_USER_ID = "11110000-0000-4000-8000-000000000001";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_ID = "66666666-6666-4666-8666-666666666666";

const APPOINTMENT_ID = "cccc3333-3333-4333-8333-333333333333";

const RESCHEDULE_INPUT = {
  appointmentId: APPOINTMENT_ID,
  newStartTime: "2026-05-10T15:00:00.000Z",
  newEndTime: "2026-05-10T15:30:00.000Z",
  reason: "Rescheduled",
};

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

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
    chain.where = fn(() => {
      const result: Record<string | symbol, unknown> = {
        orderBy: fn(async () => nextResult()),
        limit: fn(async () => nextResult()),
      };
      (result as { then: (r: (v: unknown) => void) => unknown }).then = (
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
  const updateFn = fn(() => ({
    set: fn(() => ({ where: fn(async () => undefined) })),
  }));

  const transactionFn = fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx: Record<string, unknown> = {
      select: fn(() => makeSelectChain()),
      insert: insertFn,
      update: updateFn,
    };
    return cb(tx);
  });

  return {
    state,
    makeSelectChain,
    insertFn,
    updateFn,
    transactionFn,
    assertCareTeamAccess: fn(async () => true),
    mockDb: {
      select: fn(() => makeSelectChain()),
      insert: insertFn,
      update: updateFn,
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
    appointment_type: "appointments.appointment_type",
    start_time: "appointments.start_time",
    end_time: "appointments.end_time",
    status: "appointments.status",
    location: "appointments.location",
    reason: "appointments.reason",
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

const originalAppointment = {
  id: APPOINTMENT_ID,
  patient_id: PATIENT_RECORD_ID,
  provider_id: PROVIDER_ID,
  appointment_type: "follow_up",
  start_time: "2026-05-01T15:00:00.000Z",
  end_time: "2026-05-01T15:30:00.000Z",
  status: "scheduled",
  location: "Main Clinic",
  reason: null,
};

describe("schedulingRbacRouter.appointments.cancel — server reason validation (#893)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.queue = [];
    mocks.state.default = [];
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
  });

  it("rejects an empty cancel reason with BAD_REQUEST", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      callerFor(patient).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only cancel reason with BAD_REQUEST", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      callerFor(patient).appointments.cancel({
        appointmentId: APPOINTMENT_ID,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  it("trims a valid reason before persisting", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    mocks.state.queue = [[{ patient_id: PATIENT_RECORD_ID }]];
    const result = await callerFor(patient).appointments.cancel({
      appointmentId: APPOINTMENT_ID,
      reason: "  conflict  ",
    });
    expect(result).toEqual({ success: true });
    expect(mocks.mockDb.update).toHaveBeenCalled();
  });
});

describe("schedulingRbacRouter.appointments.reschedule — atomic reschedule (#892)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.queue = [];
    mocks.state.default = [];
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
  });

  it("rejects unauthenticated callers", async () => {
    await expect(
      callerFor(null).appointments.reschedule(RESCHEDULE_INPUT),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns NOT_FOUND for a missing appointment id", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // Pre-transaction lookup returns []
    mocks.state.queue = [[]];
    await expect(
      callerFor(patient).appointments.reschedule(RESCHEDULE_INPUT),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Never enters the tx
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it("rejects cross-patient reschedule (patient role, FORBIDDEN)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: OTHER_PATIENT_RECORD_ID,
    });
    mocks.state.queue = [[originalAppointment]];
    await expect(
      callerFor(patient).appointments.reschedule(RESCHEDULE_INPUT),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it("rejects empty reschedule reason with BAD_REQUEST (Zod)", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      callerFor(patient).appointments.reschedule({
        ...RESCHEDULE_INPUT,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it("happy path: cancels original + creates new inside one transaction", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // Queue:
    //  1. pre-tx lookup of original appointment
    //  2. inside tx: select original (for fields + lock) -> [originalAppointment]
    //  3. inside tx: overlap check -> []
    mocks.state.queue = [
      [originalAppointment],
      [originalAppointment],
      [],
    ];

    const result = await callerFor(patient).appointments.reschedule(
      RESCHEDULE_INPUT,
    );

    expect(mocks.transactionFn).toHaveBeenCalledTimes(1);
    // inside the tx we both UPDATE (cancel original) and INSERT (new appt)
    expect(mocks.updateFn).toHaveBeenCalled();
    expect(mocks.insertFn).toHaveBeenCalled();
    expect(result).toMatchObject({
      patient_id: PATIENT_RECORD_ID,
      provider_id: PROVIDER_ID,
      start_time: RESCHEDULE_INPUT.newStartTime,
      end_time: RESCHEDULE_INPUT.newEndTime,
      status: "scheduled",
    });
    // The cancelled original id MUST differ from the new one.
    expect(result.id).not.toBe(APPOINTMENT_ID);
  });

  it("conflict path: rolls back when the new slot is taken", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    // Queue:
    //  1. pre-tx lookup
    //  2. inside tx: select original
    //  3. inside tx: overlap check -> [someRow] (conflict!)
    mocks.state.queue = [
      [originalAppointment],
      [originalAppointment],
      [{ id: "other-appt" }],
    ];

    await expect(
      callerFor(patient).appointments.reschedule(RESCHEDULE_INPUT),
    ).rejects.toThrow(/conflict/i);
    // No INSERT ran — tx aborted after overlap check.
    expect(mocks.insertFn).not.toHaveBeenCalled();
  });

  it("allows an admin to reschedule across patients (unrestricted)", async () => {
    const admin = makeUser("admin", ADMIN_ID);
    mocks.state.queue = [
      [{ ...originalAppointment, patient_id: OTHER_PATIENT_RECORD_ID }],
      [{ ...originalAppointment, patient_id: OTHER_PATIENT_RECORD_ID }],
      [],
    ];
    const result = await callerFor(admin).appointments.reschedule(
      RESCHEDULE_INPUT,
    );
    expect(result).toMatchObject({ patient_id: OTHER_PATIENT_RECORD_ID });
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
  });

  it("rejects a physician NOT on the care team (FORBIDDEN)", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const physician = makeUser("physician", PROVIDER_ID);
    mocks.state.queue = [[originalAppointment]];
    await expect(
      callerFor(physician).appointments.reschedule(RESCHEDULE_INPUT),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });
});
