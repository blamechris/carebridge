import { describe, it, expect, vi, beforeEach } from "vitest";

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

const mockSelectResult: Array<Record<string, unknown>> = [];
const mockSelectResult2: Array<Record<string, unknown>> = [];
let selectCallCount = 0;

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockDb = {
  select: vi.fn().mockImplementation(() => {
    const currentCall = selectCallCount++;
    const resultSet = currentCall === 0 ? mockSelectResult : mockSelectResult2;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(resultSet),
      }),
    };
  }),
  insert: mockInsert,
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  notifications: { user_id: "user_id" },
  users: {
    id: "id",
    specialty: "specialty",
    role: "role",
    is_active: "is_active",
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

// The dispatch worker exports `startDispatchWorker` which instantiates
// a BullMQ Worker. We need to access `processNotificationJob` which is
// internal. Instead we re-test the exported helpers indirectly by
// invoking the worker callback captured from the Worker constructor mock.

import type { NotificationEvent } from "../queue.js";

// Since processNotificationJob is not exported, we'll test through the
// worker callback. But actually the Worker constructor is mocked, so we
// need a different approach. Let's test the logic by importing and
// calling startDispatchWorker, then extracting the processor callback.

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

describe("dispatch-worker", () => {
  let processorFn: (job: { data: NotificationEvent; id: string }) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
    mockSelectResult.length = 0;
    mockSelectResult2.length = 0;

    // Extract the processor function passed to the Worker constructor
    const WorkerMock = Worker as unknown as ReturnType<typeof vi.fn>;
    WorkerMock.mockClear();

    startDispatchWorker();

    const constructorCall = WorkerMock.mock.calls[0];
    processorFn = constructorCall[1] as typeof processorFn;
  });

  it("creates urgent notifications for critical severity flags", async () => {
    // First select: care_team_assignments returns one user
    mockSelectResult.push({ user_id: "user-neuro" });
    // Second select: users table returns the provider
    mockSelectResult2.push({
      id: "user-neuro",
      specialty: "Neurology",
      role: "physician",
    });

    const event = makeEvent({ severity: "critical" });
    await processorFn({ data: event, id: "job-1" });

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const insertedRecords = mockInsertValues.mock.calls[0][0];
    expect(insertedRecords).toHaveLength(1);
    expect(insertedRecords[0].is_urgent).toBe(true);
    expect(insertedRecords[0].type).toBe("ai-flag");
    expect(insertedRecords[0].related_flag_id).toBe("flag-1");
  });

  it("creates urgent notifications for high severity flags", async () => {
    mockSelectResult.push({ user_id: "user-onco" });
    mockSelectResult2.push({
      id: "user-onco",
      specialty: "Hematology/Oncology",
      role: "physician",
    });

    const event = makeEvent({ severity: "high" });
    await processorFn({ data: event, id: "job-2" });

    const insertedRecords = mockInsertValues.mock.calls[0][0];
    expect(insertedRecords[0].is_urgent).toBe(true);
  });

  it("creates non-urgent notifications for warning severity flags", async () => {
    mockSelectResult.push({ user_id: "user-onco" });
    mockSelectResult2.push({
      id: "user-onco",
      specialty: "Hematology/Oncology",
      role: "physician",
    });

    const event = makeEvent({ severity: "warning" });
    await processorFn({ data: event, id: "job-3" });

    const insertedRecords = mockInsertValues.mock.calls[0][0];
    expect(insertedRecords[0].is_urgent).toBe(false);
  });

  it("creates non-urgent notifications for info severity flags", async () => {
    mockSelectResult.push({ user_id: "user-onco" });
    mockSelectResult2.push({
      id: "user-onco",
      specialty: "Hematology/Oncology",
      role: "physician",
    });

    const event = makeEvent({ severity: "info" });
    await processorFn({ data: event, id: "job-4" });

    const insertedRecords = mockInsertValues.mock.calls[0][0];
    expect(insertedRecords[0].is_urgent).toBe(false);
  });

  it("creates no notifications when no care team assignments exist", async () => {
    // First select returns empty (no assignments)
    // mockSelectResult is already empty

    const event = makeEvent();
    await processorFn({ data: event, id: "job-5" });

    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockPublishNotification).not.toHaveBeenCalled();
  });

  it("publishes real-time SSE notification with is_urgent flag", async () => {
    mockSelectResult.push({ user_id: "user-neuro" });
    mockSelectResult2.push({
      id: "user-neuro",
      specialty: "Neurology",
      role: "physician",
    });

    const event = makeEvent({ severity: "critical" });
    await processorFn({ data: event, id: "job-6" });

    expect(mockPublishNotification).toHaveBeenCalledTimes(1);
    const [userId, payload] = mockPublishNotification.mock.calls[0];
    expect(userId).toBe("user-neuro");
    expect(payload.is_urgent).toBe(true);
    expect(payload.related_flag_id).toBe("flag-1");
  });

  it("creates notifications for multiple care team members", async () => {
    mockSelectResult.push(
      { user_id: "user-neuro" },
      { user_id: "user-onco" },
    );
    mockSelectResult2.push(
      { id: "user-neuro", specialty: "Neurology", role: "physician" },
      { id: "user-onco", specialty: "Hematology/Oncology", role: "physician" },
    );

    const event = makeEvent();
    await processorFn({ data: event, id: "job-7" });

    const insertedRecords = mockInsertValues.mock.calls[0][0];
    expect(insertedRecords).toHaveLength(2);
    expect(mockPublishNotification).toHaveBeenCalledTimes(2);
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
      mockSelectResult.push({ user_id: "user-neuro" });
      mockSelectResult2.push({
        id: "user-neuro",
        specialty: "Neurology",
        role: "physician",
      });

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-1" });

      expect(mockPublishNotification).toHaveBeenCalledTimes(1);
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.body).not.toMatch(/\d/);
    });

    it("published body does not contain the raw event.summary text", async () => {
      mockSelectResult.push({ user_id: "user-neuro" });
      mockSelectResult2.push({
        id: "user-neuro",
        specialty: "Neurology",
        role: "physician",
      });

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
      mockSelectResult.push({ user_id: "user-neuro" });
      mockSelectResult2.push({
        id: "user-neuro",
        specialty: "Neurology",
        role: "physician",
      });

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-3" });

      // Reproduce buildSafeSummary locally (mirror of the private helper):
      // a category-only template, PHI-free by construction.
      const expectedSafe =
        `Clinical flag — ${event.category.replace(/-/g, " ")}. ` +
        `Open the portal to view details.`;

      const insertedRecords = mockInsertValues.mock.calls[0][0];
      expect(insertedRecords).toHaveLength(1);
      expect(insertedRecords[0].summary_safe).toBe(expectedSafe);

      // Cross-check: the same value is what we publish.
      const [, payload] = mockPublishNotification.mock.calls[0];
      expect(payload.body).toBe(expectedSafe);
    });

    it("persisted record.body still equals event.summary (full, for authenticated fetch)", async () => {
      mockSelectResult.push({ user_id: "user-neuro" });
      mockSelectResult2.push({
        id: "user-neuro",
        specialty: "Neurology",
        role: "physician",
      });

      const event = phiEvent();
      await processorFn({ data: event, id: "job-phi-4" });

      const insertedRecords = mockInsertValues.mock.calls[0][0];
      expect(insertedRecords[0].body).toBe(event.summary);
    });
  });
});
