/**
 * Integration tests for reminder hooks on the scheduling router (issue #333).
 *
 * Validates:
 *   - `appointments.create` calls `scheduleReminders` after the row commits
 *     and persists the returned job IDs.
 *   - `appointments.cancel` calls `cancelReminders` with the row's IDs.
 *   - A BullMQ failure in `scheduleReminders` MUST NOT block the booking
 *     (nice-to-have reminder; not a blocking failure).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── DB mock ─────────────────────────────────────────────────────────

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  appointments: {
    id: "id",
    patient_id: "patient_id",
    provider_id: "provider_id",
    start_time: "start_time",
    end_time: "end_time",
    status: "status",
    reminder_24h_job_id: "reminder_24h_job_id",
    reminder_2h_job_id: "reminder_2h_job_id",
  },
  providerSchedules: {},
  scheduleBlocks: {},
}));

// drizzle-orm sql builders — not used in the queries we exercise, but the
// router imports them at module scope.
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
  lte: (a: unknown, b: unknown) => ({ lte: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
}));

// Mock reminders BEFORE importing the router so its top-level import picks up
// the mocks.
const { mockScheduleReminders, mockCancelReminders } = vi.hoisted(() => ({
  mockScheduleReminders: vi.fn(),
  mockCancelReminders: vi.fn(),
}));

vi.mock("../reminders.js", () => ({
  scheduleReminders: mockScheduleReminders,
  cancelReminders: mockCancelReminders,
}));

// ── Module under test ───────────────────────────────────────────────

import { schedulingRouter } from "../router.js";

/**
 * Patch `db.transaction(cb)` to immediately invoke the callback with `db`
 * so router code that wraps a check+insert in a transaction exercises the
 * same mock selects/inserts.
 */
function withTransaction(m: MockDb): MockDb & { transaction: (cb: (tx: MockDb) => unknown) => unknown } {
  return Object.assign(m, {
    transaction: (cb: (tx: MockDb) => unknown) => cb(m),
  });
}

describe("appointments.create + reminders hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    withTransaction(db);
    mockScheduleReminders.mockReset();
    mockCancelReminders.mockReset();
  });

  it("calls scheduleReminders with the freshly inserted appointment", async () => {
    // 1. select (overlap check) → []
    // 2. insert → undefined
    // 3. update (to persist job IDs) → undefined
    db.willSelect([]);
    db.willInsert();
    db.willUpdate();

    mockScheduleReminders.mockResolvedValue({
      reminder_24h_job_id: "job-24h",
      reminder_2h_job_id: "job-2h",
    });

    const caller = schedulingRouter.createCaller({});
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

    const result = await caller.appointments.create({
      patientId: "patient-1",
      providerId: "provider-1",
      appointmentType: "follow_up",
      startTime: start,
      endTime: end,
    });

    expect(mockScheduleReminders).toHaveBeenCalledTimes(1);
    const [appointmentArg] = mockScheduleReminders.mock.calls[0];
    expect(appointmentArg.id).toBe(result.id);
    expect(appointmentArg.patient_id).toBe("patient-1");
    expect(appointmentArg.start_time).toBe(start);

    // Job IDs are returned to the caller on the appointment row.
    expect(result.reminder_24h_job_id).toBe("job-24h");
    expect(result.reminder_2h_job_id).toBe("job-2h");

    // And we persisted them via a follow-up UPDATE.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("skips the persistence UPDATE when both reminders are nulled (appointment too soon)", async () => {
    db.willSelect([]);
    db.willInsert();

    mockScheduleReminders.mockResolvedValue({
      reminder_24h_job_id: null,
      reminder_2h_job_id: null,
    });

    const caller = schedulingRouter.createCaller({});
    const start = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
    const end = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await caller.appointments.create({
      patientId: "patient-1",
      providerId: "provider-1",
      appointmentType: "telehealth",
      startTime: start,
      endTime: end,
    });

    expect(mockScheduleReminders).toHaveBeenCalledTimes(1);
    // No UPDATE — nothing to persist.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not block booking when scheduleReminders throws", async () => {
    db.willSelect([]);
    db.willInsert();

    mockScheduleReminders.mockRejectedValue(new Error("redis down"));

    const caller = schedulingRouter.createCaller({});
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

    const result = await caller.appointments.create({
      patientId: "patient-1",
      providerId: "provider-1",
      appointmentType: "follow_up",
      startTime: start,
      endTime: end,
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.reminder_24h_job_id).toBeNull();
    expect(result.reminder_2h_job_id).toBeNull();
    expect(mockScheduleReminders).toHaveBeenCalledTimes(1);
  });
});

describe("appointments.cancel + reminders hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    mockCancelReminders.mockReset();
  });

  it("loads existing job IDs then calls cancelReminders with them", async () => {
    // 1. select existing job IDs
    // 2. update (cancel)
    db.willSelect([
      { reminder_24h_job_id: "job-24h", reminder_2h_job_id: "job-2h" },
    ]);
    db.willUpdate();
    mockCancelReminders.mockResolvedValue(undefined);

    const caller = schedulingRouter.createCaller({});
    await caller.appointments.cancel({
      appointmentId: "appt-1",
      cancelledBy: "user-1",
      reason: "Patient rescheduled via phone",
    });

    expect(mockCancelReminders).toHaveBeenCalledTimes(1);
    expect(mockCancelReminders).toHaveBeenCalledWith({
      reminder_24h_job_id: "job-24h",
      reminder_2h_job_id: "job-2h",
    });
  });

  it("is a no-op on cancelReminders when the appointment row is gone", async () => {
    db.willSelect([]); // no existing row
    db.willUpdate();

    const caller = schedulingRouter.createCaller({});
    await caller.appointments.cancel({
      appointmentId: "appt-missing",
      cancelledBy: "user-1",
      reason: "n/a",
    });

    expect(mockCancelReminders).not.toHaveBeenCalled();
  });

  it("does not throw when cancelReminders fails", async () => {
    db.willSelect([
      { reminder_24h_job_id: "job-24h", reminder_2h_job_id: "job-2h" },
    ]);
    db.willUpdate();
    mockCancelReminders.mockRejectedValue(new Error("redis down"));

    const caller = schedulingRouter.createCaller({});
    await expect(
      caller.appointments.cancel({
        appointmentId: "appt-1",
        cancelledBy: "user-1",
        reason: "Patient rescheduled via phone",
      }),
    ).resolves.toEqual({ success: true });
  });
});
