import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

/**
 * Unit tests for dispatch worker notification creation logic.
 *
 * Validates that:
 * - Notifications are created for care team members matching flag specialties
 * - Critical/high flags produce urgent notifications
 * - Warning/info flags produce non-urgent notifications
 * - No notifications are created when no care team members are assigned
 */

// ── DB mocks ────────────────────────────────────────────────────────

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  notifications: { user_id: "user_id" },
  users: {
    id: "id",
    specialty: "specialty",
    role: "role",
    is_active: "is_active",
    patient_id: "patient_id",
  },
  careTeamAssignments: {
    user_id: "user_id",
    patient_id: "patient_id",
    removed_at: "removed_at",
  },
  notificationPreferences: {
    user_id: "user_id",
    notification_type: "notification_type",
    channel: "channel",
    enabled: "enabled",
    quiet_hours_start: "quiet_hours_start",
    quiet_hours_end: "quiet_hours_end",
  },
}));

// ── Redis / BullMQ mocks ────────────────────────────────────────────

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  DEFAULT_RETENTION_AGE_SECONDS: 600,
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: unknown) => ({
    _processor: processor,
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
    client: Promise.resolve({ ping: vi.fn().mockResolvedValue("PONG") }),
  })),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { mockPublishNotification } = vi.hoisted(() => ({
  mockPublishNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../publish.js", () => ({
  publishNotification: mockPublishNotification,
}));

// ── Import module under test (after mocks) ──────────────────────────

import type { NotificationEvent } from "../queue.js";
import { startDispatchWorker } from "../workers/dispatch-worker.js";
import { Worker } from "bullmq";

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    flag_id: "flag-1",
    patient_id: "patient-1",
    severity: "critical",
    category: "cross-specialty",
    summary: "Elevated stroke risk in cancer patient with VTE",
    suggested_action: "Urgent neurological evaluation",
    notify_specialties: ["neurology", "hematology"],
    source: "rules",
    created_at: "2026-04-12T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * Prime the `db` mock for a full dispatch-worker job:
 *  1. care_team_assignments select
 *  2. users select
 *  3. per-recipient notification_preferences select (one per recipient;
 *     empty → opt-out default).
 */
function primeDispatch(
  assignments: Array<Record<string, unknown>>,
  providers: Array<Record<string, unknown>>,
): void {
  db.willSelect(assignments);
  db.willSelect(providers);
  for (let i = 0; i < providers.length; i++) {
    db.willSelect([]);
  }
}

/**
 * Extract the records array passed to `db.insert(notifications).values(...)`.
 */
function getInsertedRecords(): Array<Record<string, unknown>> {
  const call = db.insert.calls[0];
  if (!call) throw new Error("expected db.insert to have been called");
  const valuesIdx = call.chain.indexOf("values");
  return call.chainArgs[valuesIdx]?.[0] as Array<Record<string, unknown>>;
}

describe("dispatch-worker", () => {
  let processorFn: (job: { data: NotificationEvent; id: string }) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();

    // Extract the processor function passed to the Worker constructor
    const WorkerMock = Worker as unknown as ReturnType<typeof vi.fn>;
    WorkerMock.mockClear();

    startDispatchWorker();

    const constructorCall = WorkerMock.mock.calls[0];
    processorFn = constructorCall[1] as typeof processorFn;
  });

  it("creates urgent notifications for critical severity flags", async () => {
    primeDispatch(
      [{ user_id: "user-neuro" }],
      [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
    );

    const event = makeEvent({ severity: "critical" });
    await processorFn({ data: event, id: "job-1" });

    expect(db.insert).toHaveBeenCalledOnce();
    const insertedRecords = getInsertedRecords();
    expect(insertedRecords).toHaveLength(1);
    expect(insertedRecords[0].is_urgent).toBe(true);
    expect(insertedRecords[0].type).toBe("ai-flag");
    expect(insertedRecords[0].related_flag_id).toBe("flag-1");
  });

  it("creates urgent notifications for high severity flags", async () => {
    primeDispatch(
      [{ user_id: "user-onco" }],
      [{ id: "user-onco", specialty: "Hematology/Oncology", role: "physician" }],
    );

    const event = makeEvent({ severity: "high" });
    await processorFn({ data: event, id: "job-2" });

    const insertedRecords = getInsertedRecords();
    expect(insertedRecords[0].is_urgent).toBe(true);
  });

  it("creates non-urgent notifications for warning severity flags", async () => {
    primeDispatch(
      [{ user_id: "user-onco" }],
      [{ id: "user-onco", specialty: "Hematology/Oncology", role: "physician" }],
    );

    const event = makeEvent({ severity: "warning" });
    await processorFn({ data: event, id: "job-3" });

    const insertedRecords = getInsertedRecords();
    expect(insertedRecords[0].is_urgent).toBe(false);
  });

  it("creates non-urgent notifications for info severity flags", async () => {
    primeDispatch(
      [{ user_id: "user-onco" }],
      [{ id: "user-onco", specialty: "Hematology/Oncology", role: "physician" }],
    );

    const event = makeEvent({ severity: "info" });
    await processorFn({ data: event, id: "job-4" });

    const insertedRecords = getInsertedRecords();
    expect(insertedRecords[0].is_urgent).toBe(false);
  });

  it("creates no notifications when no care team assignments exist", async () => {
    // First select returns empty (no assignments) — subsequent selects
    // are never reached because the early-return in
    // `findNotificationRecipients` fires on the empty result.
    db.willSelect([]);

    const event = makeEvent();
    await processorFn({ data: event, id: "job-5" });

    expect(db.insert).not.toHaveBeenCalled();
    expect(mockPublishNotification).not.toHaveBeenCalled();
  });

  it("publishes real-time SSE notification with is_urgent flag", async () => {
    primeDispatch(
      [{ user_id: "user-neuro" }],
      [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
    );

    const event = makeEvent({ severity: "critical" });
    await processorFn({ data: event, id: "job-6" });

    expect(mockPublishNotification).toHaveBeenCalledTimes(1);
    const [userId, payload] = mockPublishNotification.mock.calls[0];
    expect(userId).toBe("user-neuro");
    expect(payload.is_urgent).toBe(true);
    expect(payload.related_flag_id).toBe("flag-1");
  });

  it("creates notifications for multiple care team members", async () => {
    primeDispatch(
      [{ user_id: "user-neuro" }, { user_id: "user-onco" }],
      [
        { id: "user-neuro", specialty: "Neurology", role: "physician" },
        { id: "user-onco", specialty: "Hematology/Oncology", role: "physician" },
      ],
    );

    const event = makeEvent();
    await processorFn({ data: event, id: "job-7" });

    const insertedRecords = getInsertedRecords();
    expect(insertedRecords).toHaveLength(2);
    expect(mockPublishNotification).toHaveBeenCalledTimes(2);
  });

  // ── Audience routing (issue #897 fix) ────────────────────────────
  //
  // Appointment reminders must NOT route via `careTeamAssignments` —
  // that would deliver the patient's reminder to their PROVIDERS,
  // which is a HIPAA-adjacent misdelivery. The `audience: "patient"`
  // branch looks up the patient's own user row via `users.patient_id`
  // and targets it directly.

  describe("audience routing", () => {
    it("routes to the patient's own user id when audience='patient'", async () => {
      // 1st select: patient user lookup (users WHERE patient_id = ...)
      db.willSelect([{ id: "user-patient-1" }]);
      // 2nd select: per-recipient notification_preferences (empty → default opt-in)
      db.willSelect([]);

      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
        notify_specialties: [],
      });
      await processorFn({ data: event, id: "job-aud-1" });

      expect(db.insert).toHaveBeenCalledOnce();
      const insertedRecords = getInsertedRecords();
      expect(insertedRecords).toHaveLength(1);
      expect(insertedRecords[0].user_id).toBe("user-patient-1");
    });

    it("skips delivery when no active user row owns the patient_id", async () => {
      // Patient user lookup returns empty (patient hasn't registered a
      // portal account, or their user row is inactive).
      db.willSelect([]);

      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
      });
      await processorFn({ data: event, id: "job-aud-2" });

      expect(db.insert).not.toHaveBeenCalled();
      expect(mockPublishNotification).not.toHaveBeenCalled();
    });

    it("keeps care-team routing when audience is omitted (default='providers')", async () => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );

      // `audience` intentionally omitted — we rely on the server-side
      // default ("providers") so existing ai-oversight callers are
      // unaffected.
      const event = makeEvent();
      await processorFn({ data: event, id: "job-aud-3" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords).toHaveLength(1);
      expect(insertedRecords[0].user_id).toBe("user-neuro");
    });

    it("uses care-team routing when audience='providers' explicitly", async () => {
      primeDispatch(
        [{ user_id: "user-onco" }],
        [{ id: "user-onco", specialty: "Hematology/Oncology", role: "physician" }],
      );

      const event = makeEvent({ audience: "providers" });
      await processorFn({ data: event, id: "job-aud-4" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords).toHaveLength(1);
      expect(insertedRecords[0].user_id).toBe("user-onco");
    });
  });

  // ── Scheduling reminder titles (issue #897 fix) ───────────────────

  describe("scheduling.reminder source", () => {
    const primePatient = (): void => {
      db.willSelect([{ id: "user-patient-1" }]);
      db.willSelect([]); // preferences
    };

    it("renders title as 'Appointment reminder' (no severity prefix, no 'Clinical flag —')", async () => {
      primePatient();

      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
        summary: "Reminder: You have an appointment with Dr. Smith tomorrow at 2:30 PM UTC.",
      });
      await processorFn({ data: event, id: "job-src-1" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords[0].title).toBe("Appointment reminder");
      expect(insertedRecords[0].title).not.toContain("Clinical flag");
      expect(insertedRecords[0].title).not.toContain("Info:");
    });

    it("renders summary_safe with a reminder-shaped template (no 'Clinical flag —')", async () => {
      primePatient();

      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
      });
      await processorFn({ data: event, id: "job-src-2" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords[0].summary_safe).toBe(
        "You have an upcoming appointment. Open the portal for details.",
      );
      expect(insertedRecords[0].summary_safe).not.toContain("Clinical flag");
    });

    it("keeps the PHI-carrying full summary on record.body for authenticated fetch", async () => {
      primePatient();

      const fullSummary =
        "Reminder: You have an appointment with Dr. Smith tomorrow at 2:30 PM UTC at Main Clinic.";
      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
        summary: fullSummary,
      });
      await processorFn({ data: event, id: "job-src-3" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords[0].body).toBe(fullSummary);
    });

    it("published lock-screen payload for reminders carries no PHI", async () => {
      primePatient();

      const event = makeEvent({
        audience: "patient",
        severity: "info",
        category: "appointment-reminder",
        source: "scheduling.reminder",
        summary: "Reminder: You have an appointment with Dr. Alice Smith at 2:30 PM UTC.",
      });
      await processorFn({ data: event, id: "job-src-4" });

      expect(mockPublishNotification).toHaveBeenCalledTimes(1);
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.title).toBe("Appointment reminder");
      expect(payload.body).toBe(
        "You have an upcoming appointment. Open the portal for details.",
      );
      expect(payload.body).not.toContain("Alice");
      expect(payload.body).not.toContain("Smith");
      expect(payload.body).not.toContain("2:30");
      expect(payload.body).not.toMatch(/\d/);
    });
  });

  // ── PHI lock-screen safety (issue #289) ────────────────────────────
  //
  // These tests lock in the two-tier split: the Redis pub/sub payload
  // (what any future APNs/FCM integration hands to the OS for lock-screen
  // render) must never contain PHI, while the persisted notification row
  // must still carry the full summary for the authenticated portal fetch.

  describe("PHI lock-screen safety", () => {
    const phiEvent = (): NotificationEvent =>
      makeEvent({
        severity: "critical",
        category: "critical-value",
        summary: "Potassium = 7.2 mmol/L for MRN 123456, BP 145/95",
      });

    it("published body contains no numeric values", async () => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-1" });

      expect(mockPublishNotification).toHaveBeenCalledTimes(1);
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.body).not.toMatch(/\d/);
    });

    it("published body does not contain the raw event.summary text", async () => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-2" });

      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.body).not.toContain(event.summary);
      // And individual PHI tokens from the summary must not leak.
      expect(payload.body).not.toContain("Potassium");
      expect(payload.body).not.toContain("MRN");
      expect(payload.body).not.toContain("7.2");
      expect(payload.body).not.toContain("145/95");
    });

    it("persisted record.summary_safe equals the buildSafeSummary output", async () => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-3" });

      // Reproduce buildSafeSummary locally (mirror of the private helper):
      // a category-only template, PHI-free by construction. The category
      // is rendered through the whitelist label (`critical-value` →
      // "Critical value") rather than a raw dash→space transform.
      const expectedSafe =
        "Clinical flag — Critical value. Open the portal to view details.";

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords).toHaveLength(1);
      expect(insertedRecords[0].summary_safe).toBe(expectedSafe);

      // Cross-check: the same value is what we publish.
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.body).toBe(expectedSafe);
    });

    it("persisted record.body still equals event.summary (full, for authenticated fetch)", async () => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-4" });

      const insertedRecords = getInsertedRecords();
      expect(insertedRecords[0].body).toBe(event.summary);
    });
  });

  // Category whitelist (issue #551).
  // `NotificationEvent.category` is typed as `string`, so a future rule
  // author or LLM could pass something like `"psychiatric-symptoms"` that
  // would otherwise render verbatim on a device lock screen. These tests
  // lock in the whitelist + generic fallback + observability behaviour.
  describe("category whitelist", () => {
    const primeRecipients = (): void => {
      primeDispatch(
        [{ user_id: "user-neuro" }],
        [{ id: "user-neuro", specialty: "Neurology", role: "physician" }],
      );
    };

    // Clinical-flag categories render with the full
    // "<Severity>: Clinical flag — <label>" prefix. The
    // appointment-reminder category is covered separately in the
    // `scheduling.reminder source` describe block because its source
    // branch suppresses the clinical-flag prefix entirely.
    const knownCategoryCases: Array<[string, string]> = [
      ["cross-specialty", "Cross-specialty concern"],
      ["drug-interaction", "Drug interaction"],
      ["medication-safety", "Medication safety"],
      ["care-gap", "Care gap"],
      ["critical-value", "Critical value"],
      ["trend-concern", "Trend concern"],
      ["documentation-discrepancy", "Documentation discrepancy"],
      ["patient-reported", "Patient-reported concern"],
    ];

    for (const [category, label] of knownCategoryCases) {
      it(`renders whitelisted category "${category}" as "${label}"`, async () => {
        primeRecipients();

        const errorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);

        const event = makeEvent({ severity: "warning", category });
        await processorFn({ data: event, id: `job-cat-${category}` });

        const insertedRecords = getInsertedRecords();
        expect(insertedRecords[0].title).toBe(
          `Warning: Clinical flag — ${label}`,
        );
        expect(insertedRecords[0].summary_safe).toBe(
          `Clinical flag — ${label}. Open the portal to view details.`,
        );
        // Known categories must not trigger the unknown-category warning.
        const unknownCatCalls = errorSpy.mock.calls.filter((call) => {
          if (typeof call[0] !== "string") return false;
          try {
            const parsed = JSON.parse(call[0]);
            return parsed.msg?.includes("Unknown notification category");
          } catch {
            return false;
          }
        });
        expect(unknownCatCalls).toHaveLength(0);

        errorSpy.mockRestore();
      });
    }

    it("falls back to 'Clinical alert' for unknown categories", async () => {
      primeRecipients();

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const event = makeEvent({
        severity: "critical",
        // Unknown, PHI-adjacent category that MUST NOT surface verbatim.
        category: "hiv-status-change",
      });
      await processorFn({ data: event, id: "job-cat-unknown" });

      const insertedRecords = getInsertedRecords();
      const title = insertedRecords[0].title as string;
      const safeSummary = insertedRecords[0].summary_safe as string;

      expect(title).toBe("CRITICAL: Clinical flag — Clinical alert");
      expect(safeSummary).toBe(
        "Clinical flag — Clinical alert. Open the portal to view details.",
      );
      // The raw, unknown category must not leak into either field.
      expect(title).not.toContain("hiv");
      expect(title).not.toContain("status");
      expect(safeSummary).not.toContain("hiv");

      // Observability: unknown categories are logged with structured context
      // so the operator can triage and either admit them to the whitelist
      // or fix the upstream rule/LLM output.
      // Issue #591: resolveCategoryLabel is called once per event, so the
      // unknown-category warning must fire exactly once (not once per helper).
      const unknownWarnCalls = errorSpy.mock.calls.filter((call) => {
        if (typeof call[0] !== "string") return false;
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.msg?.includes("Unknown notification category");
        } catch {
          return false;
        }
      });
      expect(unknownWarnCalls).toHaveLength(1);
      const parsed = JSON.parse(unknownWarnCalls[0]![0] as string);
      expect(parsed.category).toBe("hiv-status-change");
      expect(parsed.fallback).toBe("Clinical alert");

      errorSpy.mockRestore();
    });

    it("published lock-screen payload uses fallback label and carries no PHI for unknown categories", async () => {
      primeRecipients();

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const event = makeEvent({
        severity: "warning",
        category: "psychiatric-symptoms-self-harm",
        summary: "Patient MRN 987654 reports ideation; BP 145/95",
      });
      await processorFn({ data: event, id: "job-cat-unknown-phi" });

      expect(mockPublishNotification).toHaveBeenCalledTimes(1);
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.title).toBe("Warning: Clinical flag — Clinical alert");
      expect(payload.body).toBe(
        "Clinical flag — Clinical alert. Open the portal to view details.",
      );
      // Neither the raw summary nor the suspicious category should leak.
      expect(payload.title).not.toContain("psychiatric");
      expect(payload.body).not.toContain("psychiatric");
      expect(payload.body).not.toContain("MRN");
      expect(payload.body).not.toMatch(/\d/);

      errorSpy.mockRestore();
    });
  });
});
