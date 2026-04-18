/**
 * Unit tests for the appointment-reminders worker (issue #333).
 *
 * Validates:
 *   - Happy path: fires, loads the appointment, emits a notification event.
 *   - Cancelled appointment: skips without emitting.
 *   - Missing appointment (e.g. deleted): skips without throwing.
 *   - PHI safety: `summary_safe` (via `suggested_action`) carries no PHI;
 *     full summary MAY contain provider name + time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── DB mock ─────────────────────────────────────────────────────────

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  appointments: {
    id: "id",
    status: "status",
    start_time: "start_time",
    patient_id: "patient_id",
    provider_id: "provider_id",
    location: "location",
    reason: "reason",
  },
  users: {
    id: "id",
    name: "name",
  },
}));

// ── BullMQ / Redis mocks ────────────────────────────────────────────

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(), getJob: vi.fn() })),
  Worker: vi.fn(),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  DEFAULT_RETENTION_AGE_SECONDS: 600,
}));

// ── Notifications mock ──────────────────────────────────────────────

const { mockEmitNotificationEvent } = vi.hoisted(() => ({
  mockEmitNotificationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@carebridge/notifications", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

// ── Module under test ───────────────────────────────────────────────

import {
  processReminderJob,
  buildReminderSummary,
  formatClockTime,
} from "../workers/reminder-worker.js";
import type { AppointmentReminderJob } from "../reminders.js";

describe("formatClockTime", () => {
  it("renders afternoon ISO times in 12h form with UTC suffix", () => {
    expect(formatClockTime("2026-04-17T14:30:00.000Z")).toBe("2:30 PM UTC");
  });

  it("renders midnight as 12:00 AM", () => {
    expect(formatClockTime("2026-04-17T00:00:00.000Z")).toBe("12:00 AM UTC");
  });

  it("renders noon as 12:00 PM", () => {
    expect(formatClockTime("2026-04-17T12:00:00.000Z")).toBe("12:00 PM UTC");
  });

  it("zero-pads minutes", () => {
    expect(formatClockTime("2026-04-17T09:05:00.000Z")).toBe("9:05 AM UTC");
  });

  it("returns the raw string for invalid input", () => {
    expect(formatClockTime("not-a-date")).toBe("not-a-date");
  });
});

describe("buildReminderSummary", () => {
  it("renders the 24h-before form with 'tomorrow'", () => {
    const text = buildReminderSummary({
      type: "reminder_24h",
      providerName: "Dr. Smith",
      startTime: "2026-04-17T14:30:00.000Z",
      location: "Main Clinic, Room 204",
      reason: "Follow-up oncology visit",
    });
    expect(text).toContain("Dr. Smith");
    expect(text).toContain("tomorrow");
    expect(text).toContain("2:30 PM");
    expect(text).toContain("Main Clinic, Room 204");
    expect(text).toContain("Follow-up oncology visit");
  });

  it("renders the 2h-before form with 'in 2 hours'", () => {
    const text = buildReminderSummary({
      type: "reminder_2h",
      providerName: "Dr. Jones",
      startTime: "2026-04-17T14:30:00.000Z",
      location: null,
      reason: null,
    });
    expect(text).toContain("Dr. Jones");
    expect(text).toContain("in 2 hours");
  });

  it("omits the location clause when null", () => {
    const text = buildReminderSummary({
      type: "reminder_24h",
      providerName: "Dr. Jones",
      startTime: "2026-04-17T14:30:00.000Z",
      location: null,
      reason: null,
    });
    expect(text).not.toContain(" at null");
    expect(text).not.toContain("Reason:");
  });
});

describe("processReminderJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    mockEmitNotificationEvent.mockReset().mockResolvedValue(undefined);
  });

  function primeAppointmentAndProvider(opts: {
    appointment?: Record<string, unknown> | null;
    provider?: Record<string, unknown> | null;
  }) {
    if (opts.appointment === null) {
      db.willSelect([]); // empty appointment lookup
    } else if (opts.appointment) {
      db.willSelect([opts.appointment]);
    }
    if (opts.provider !== undefined) {
      if (opts.provider === null) {
        db.willSelect([]);
      } else {
        db.willSelect([opts.provider]);
      }
    }
  }

  const makePayload = (overrides: Partial<AppointmentReminderJob> = {}): AppointmentReminderJob => ({
    appointment_id: "appt-1",
    user_id: "patient-1",
    type: "reminder_24h",
    ...overrides,
  });

  it("emits a notification event for an active appointment", async () => {
    primeAppointmentAndProvider({
      appointment: {
        id: "appt-1",
        status: "scheduled",
        patient_id: "patient-1",
        provider_id: "provider-1",
        start_time: "2026-04-18T14:30:00.000Z",
        location: "Main Clinic",
        reason: "Follow-up",
      },
      provider: { name: "Dr. Smith" },
    });

    const outcome = await processReminderJob(makePayload());

    expect(outcome).toBe("emitted");
    expect(mockEmitNotificationEvent).toHaveBeenCalledTimes(1);

    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.flag_id).toBe("appt-1");
    expect(event.patient_id).toBe("patient-1");
    expect(event.severity).toBe("info");
    expect(event.source).toBe("scheduling.reminder");
    expect(event.summary).toContain("Dr. Smith");
    expect(event.summary).toContain("tomorrow");
    expect(event.summary).toContain("Main Clinic");
  });

  it("uses 'your provider' fallback when the provider lookup returns no row", async () => {
    primeAppointmentAndProvider({
      appointment: {
        id: "appt-1",
        status: "scheduled",
        patient_id: "patient-1",
        provider_id: "provider-missing",
        start_time: "2026-04-18T14:30:00.000Z",
        location: null,
        reason: null,
      },
      provider: null,
    });

    await processReminderJob(makePayload());

    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.summary).toContain("your provider");
    expect(event.summary).not.toContain("undefined");
  });

  it("skips (and does not emit) when the appointment is cancelled", async () => {
    primeAppointmentAndProvider({
      appointment: {
        id: "appt-1",
        status: "cancelled",
        patient_id: "patient-1",
        provider_id: "provider-1",
        start_time: "2026-04-18T14:30:00.000Z",
        location: "Main Clinic",
        reason: null,
      },
    });

    const outcome = await processReminderJob(makePayload());

    expect(outcome).toBe("skipped_cancelled");
    expect(mockEmitNotificationEvent).not.toHaveBeenCalled();
  });

  it("skips (and does not throw) when the appointment has been deleted", async () => {
    primeAppointmentAndProvider({ appointment: null });

    const outcome = await processReminderJob(makePayload());

    expect(outcome).toBe("skipped_missing");
    expect(mockEmitNotificationEvent).not.toHaveBeenCalled();
  });

  it("uses 'in 2 hours' wording for reminder_2h payloads", async () => {
    primeAppointmentAndProvider({
      appointment: {
        id: "appt-1",
        status: "scheduled",
        patient_id: "patient-1",
        provider_id: "provider-1",
        start_time: "2026-04-18T14:30:00.000Z",
        location: null,
        reason: null,
      },
      provider: { name: "Dr. Smith" },
    });

    await processReminderJob(makePayload({ type: "reminder_2h" }));

    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.summary).toContain("in 2 hours");
    expect(event.summary).not.toContain("tomorrow");
  });

  // ── PHI lock-screen safety (issue #333) ───────────────────────────

  describe("PHI safety", () => {
    it("suggested_action (the safe summary) contains no provider name", async () => {
      primeAppointmentAndProvider({
        appointment: {
          id: "appt-1",
          status: "scheduled",
          patient_id: "patient-1",
          provider_id: "provider-1",
          start_time: "2026-04-18T14:30:00.000Z",
          location: "Oncology Suite 4",
          reason: "Chemotherapy follow-up",
        },
        provider: { name: "Dr. Alice Smith" },
      });

      await processReminderJob(makePayload());

      const event = mockEmitNotificationEvent.mock.calls[0][0];
      // The "safe" payload lives on `suggested_action`; dispatch-worker
      // already owns the separate PHI-free `summary_safe` render from the
      // whitelisted category label, but our suggested_action itself must
      // not leak PHI either.
      expect(event.suggested_action).not.toContain("Alice");
      expect(event.suggested_action).not.toContain("Smith");
      expect(event.suggested_action).not.toContain("Dr.");
      expect(event.suggested_action).not.toContain("Oncology");
      expect(event.suggested_action).not.toContain("Chemotherapy");
    });

    it("suggested_action contains no patient id or appointment time", async () => {
      primeAppointmentAndProvider({
        appointment: {
          id: "appt-1",
          status: "scheduled",
          patient_id: "patient-mrn-123456",
          provider_id: "provider-1",
          start_time: "2026-04-18T14:30:00.000Z",
          location: null,
          reason: null,
        },
        provider: { name: "Dr. Smith" },
      });

      await processReminderJob(makePayload());

      const event = mockEmitNotificationEvent.mock.calls[0][0];
      expect(event.suggested_action).not.toContain("patient-mrn-123456");
      expect(event.suggested_action).not.toContain("2:30");
      expect(event.suggested_action).not.toContain("2026-04-18");
      // Safe summary is static — contains no digits at all.
      expect(event.suggested_action).not.toMatch(/\d/);
    });

    it("uses a whitelisted category for lock-screen label safety", async () => {
      primeAppointmentAndProvider({
        appointment: {
          id: "appt-1",
          status: "scheduled",
          patient_id: "patient-1",
          provider_id: "provider-1",
          start_time: "2026-04-18T14:30:00.000Z",
          location: null,
          reason: null,
        },
        provider: { name: "Dr. Smith" },
      });

      await processReminderJob(makePayload());

      const event = mockEmitNotificationEvent.mock.calls[0][0];
      // The dispatch-worker's CATEGORY_LABELS whitelist (see
      // services/notifications/src/workers/dispatch-worker.ts) maps this
      // to "Patient-reported concern" — PHI-free by construction. Using
      // any non-whitelisted category would fall back to "Clinical alert"
      // which is still safe, but we want a predictable label here.
      expect(event.category).toBe("patient-reported");
    });
  });
});
