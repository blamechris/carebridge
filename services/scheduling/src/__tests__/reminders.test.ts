/**
 * Unit tests for `scheduleReminders` / `cancelReminders` (issue #333).
 *
 * The module under test owns the `appointment-reminders` BullMQ queue and
 * converts an appointment row into two delayed jobs (24 h / 2 h before
 * start_time). We mock `bullmq` so no Redis is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── BullMQ mock ─────────────────────────────────────────────────────

const { queueAdd, queueGetJob, jobRemove } = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  jobRemove: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: queueAdd,
    getJob: queueGetJob,
  })),
  Worker: vi.fn(),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  DEFAULT_RETENTION_AGE_SECONDS: 600,
}));

// ── Module under test ───────────────────────────────────────────────

import {
  scheduleReminders,
  cancelReminders,
  REMINDER_24H_MS,
  REMINDER_2H_MS,
  REMINDERS_QUEUE_NAME,
} from "../reminders.js";

function makeAppointment(startTime: string, overrides: Partial<{
  id: string;
  patient_id: string;
}> = {}) {
  return {
    id: overrides.id ?? "appt-abc",
    patient_id: overrides.patient_id ?? "patient-xyz",
    start_time: startTime,
  };
}

describe("REMINDERS_QUEUE_NAME", () => {
  it("is the canonical queue name", () => {
    expect(REMINDERS_QUEUE_NAME).toBe("appointment-reminders");
  });
});

describe("REMINDER_24H_MS / REMINDER_2H_MS", () => {
  it("match clock expectations", () => {
    expect(REMINDER_24H_MS).toBe(24 * 60 * 60 * 1000);
    expect(REMINDER_2H_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("scheduleReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueAdd.mockReset();
  });

  it("schedules both 24h and 2h jobs for a future appointment", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    // Appointment 48 h out → both offsets should fit.
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: "job-24h" })
      .mockResolvedValueOnce({ id: "job-2h" });

    const result = await scheduleReminders(makeAppointment(start), now);

    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      reminder_24h_job_id: "job-24h",
      reminder_2h_job_id: "job-2h",
    });
  });

  it("computes the 24h job delay as (start - 24h - now)", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: "job-24h" })
      .mockResolvedValueOnce({ id: "job-2h" });

    await scheduleReminders(makeAppointment(start), now);

    const firstCall = queueAdd.mock.calls[0];
    const options = firstCall[2] as { delay: number };
    // 48 h away − 24 h offset = 24 h delay.
    expect(options.delay).toBe(24 * 60 * 60 * 1000);
  });

  it("computes the 2h job delay as (start - 2h - now)", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: "job-24h" })
      .mockResolvedValueOnce({ id: "job-2h" });

    await scheduleReminders(makeAppointment(start), now);

    const secondCall = queueAdd.mock.calls[1];
    const options = secondCall[2] as { delay: number };
    // 48 h away − 2 h offset = 46 h delay.
    expect(options.delay).toBe(46 * 60 * 60 * 1000);
  });

  it("uses the appointment type as the job name for downstream filtering", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: "job-24h" })
      .mockResolvedValueOnce({ id: "job-2h" });

    await scheduleReminders(makeAppointment(start), now);

    expect(queueAdd.mock.calls[0][0]).toBe("reminder_24h");
    expect(queueAdd.mock.calls[1][0]).toBe("reminder_2h");
  });

  it("encodes appointment_id, user_id, and type on each job payload", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: "job-24h" })
      .mockResolvedValueOnce({ id: "job-2h" });

    await scheduleReminders(
      makeAppointment(start, { id: "appt-99", patient_id: "patient-42" }),
      now,
    );

    expect(queueAdd.mock.calls[0][1]).toEqual({
      appointment_id: "appt-99",
      user_id: "patient-42",
      type: "reminder_24h",
    });
    expect(queueAdd.mock.calls[1][1]).toEqual({
      appointment_id: "appt-99",
      user_id: "patient-42",
      type: "reminder_2h",
    });
  });

  it("skips the 24h reminder when the appointment is less than 24h out", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    // 6 h out → 2 h reminder fits (4 h delay), 24 h does not (negative delay).
    const start = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();

    queueAdd.mockResolvedValueOnce({ id: "job-2h" });

    const result = await scheduleReminders(makeAppointment(start), now);

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][0]).toBe("reminder_2h");
    expect(result.reminder_24h_job_id).toBeNull();
    expect(result.reminder_2h_job_id).toBe("job-2h");
  });

  it("skips both reminders when the appointment is less than 2h out", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 30 * 60 * 1000).toISOString(); // 30 min

    const result = await scheduleReminders(makeAppointment(start), now);

    expect(queueAdd).not.toHaveBeenCalled();
    expect(result).toEqual({
      reminder_24h_job_id: null,
      reminder_2h_job_id: null,
    });
  });

  it("skips both reminders when the appointment is in the past", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const result = await scheduleReminders(makeAppointment(start), now);

    expect(queueAdd).not.toHaveBeenCalled();
    expect(result.reminder_24h_job_id).toBeNull();
    expect(result.reminder_2h_job_id).toBeNull();
  });

  it("returns nulls when start_time is not a valid ISO string", async () => {
    const result = await scheduleReminders(makeAppointment("not-a-date"));
    expect(queueAdd).not.toHaveBeenCalled();
    expect(result.reminder_24h_job_id).toBeNull();
    expect(result.reminder_2h_job_id).toBeNull();
  });

  it("returns null when bullmq returns a job with no id (defensive)", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const start = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    queueAdd
      .mockResolvedValueOnce({ id: undefined })
      .mockResolvedValueOnce({ id: undefined });

    const result = await scheduleReminders(makeAppointment(start), now);

    expect(result.reminder_24h_job_id).toBeNull();
    expect(result.reminder_2h_job_id).toBeNull();
  });
});

describe("cancelReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueGetJob.mockReset();
    jobRemove.mockReset();
  });

  it("calls job.remove() for both populated ids", async () => {
    queueGetJob
      .mockResolvedValueOnce({ remove: jobRemove })
      .mockResolvedValueOnce({ remove: jobRemove });
    jobRemove.mockResolvedValue(undefined);

    await cancelReminders({
      reminder_24h_job_id: "job-24h",
      reminder_2h_job_id: "job-2h",
    });

    expect(queueGetJob).toHaveBeenCalledTimes(2);
    expect(queueGetJob).toHaveBeenNthCalledWith(1, "job-24h");
    expect(queueGetJob).toHaveBeenNthCalledWith(2, "job-2h");
    expect(jobRemove).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when both ids are null", async () => {
    await cancelReminders({
      reminder_24h_job_id: null,
      reminder_2h_job_id: null,
    });

    expect(queueGetJob).not.toHaveBeenCalled();
    expect(jobRemove).not.toHaveBeenCalled();
  });

  it("is a no-op when both ids are undefined", async () => {
    await cancelReminders({
      reminder_24h_job_id: undefined,
      reminder_2h_job_id: undefined,
    });

    expect(queueGetJob).not.toHaveBeenCalled();
    expect(jobRemove).not.toHaveBeenCalled();
  });

  it("skips only the null id when one is null and one is set", async () => {
    queueGetJob.mockResolvedValueOnce({ remove: jobRemove });
    jobRemove.mockResolvedValue(undefined);

    await cancelReminders({
      reminder_24h_job_id: null,
      reminder_2h_job_id: "job-2h",
    });

    expect(queueGetJob).toHaveBeenCalledTimes(1);
    expect(queueGetJob).toHaveBeenCalledWith("job-2h");
    expect(jobRemove).toHaveBeenCalledTimes(1);
  });

  it("silently tolerates jobs that no longer exist in the queue", async () => {
    // BullMQ returns undefined when the job has already been cleaned up.
    queueGetJob.mockResolvedValue(undefined);

    await expect(
      cancelReminders({
        reminder_24h_job_id: "stale-id",
        reminder_2h_job_id: "also-stale",
      }),
    ).resolves.toBeUndefined();

    expect(jobRemove).not.toHaveBeenCalled();
  });

  it("does not throw when job.remove() rejects (job already fired / locked)", async () => {
    queueGetJob.mockResolvedValue({ remove: jobRemove });
    jobRemove.mockRejectedValue(new Error("job is locked"));

    // The cancel path must be best-effort — a failure here must NOT bubble
    // out of the cancel mutation.
    await expect(
      cancelReminders({
        reminder_24h_job_id: "job-24h",
        reminder_2h_job_id: "job-2h",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when queue.getJob() rejects (redis down)", async () => {
    queueGetJob.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      cancelReminders({
        reminder_24h_job_id: "job-24h",
        reminder_2h_job_id: "job-2h",
      }),
    ).resolves.toBeUndefined();
  });
});
