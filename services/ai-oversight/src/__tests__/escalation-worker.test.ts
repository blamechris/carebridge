import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the DB --------------------------------------------------------------
//
// We capture `update().set().where()` calls so we can assert on the
// payload each escalation writes, and make `select().from().where()`
// configurable per-test so we can simulate different sets of stale flags
// per severity.

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockSelectWhere = vi.fn();

const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();

const mockDb = {
  select: mockSelect,
  update: mockUpdate,
};

// The worker references `clinicalFlags.<column>` when composing its query.
// We stub each referenced column with an identity string — good enough for
// the drizzle helpers we use in the assertions (eq/lt/isNull/and).
vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  clinicalFlags: {
    id: "id",
    patient_id: "patient_id",
    status: "status",
    severity: "severity",
    acknowledged_at: "acknowledged_at",
    escalation_count: "escalation_count",
    last_escalated_at: "last_escalated_at",
    created_at: "created_at",
    notify_specialties: "notify_specialties",
    category: "category",
    summary: "summary",
    suggested_action: "suggested_action",
    source: "source",
  },
}));

// Avoid pulling Redis / BullMQ during module load.
vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    add = vi.fn();
  },
  Worker: class MockWorker {
    on = vi.fn();
  },
}));

const { mockEmitNotificationEvent } = vi.hoisted(() => ({
  mockEmitNotificationEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@carebridge/notifications", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

import {
  checkAndEscalate,
  MAX_ESCALATIONS,
  THRESHOLDS,
} from "../workers/escalation-worker.js";

type StaleFlag = {
  id: string;
  patient_id: string;
  severity: string;
  category: string;
  summary: string;
  suggested_action: string;
  notify_specialties: string[];
  source: string;
  created_at: string;
  escalation_count: number;
  last_escalated_at: string | null;
};

function makeFlag(overrides: Partial<StaleFlag> = {}): StaleFlag {
  return {
    id: "flag-1",
    patient_id: "pat-1",
    severity: "critical",
    category: "critical-value",
    summary: "K+ 2.3 — severe hypokalemia",
    suggested_action: "Urgent potassium replacement",
    notify_specialties: ["nephrology"],
    source: "rules",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    escalation_count: 0,
    last_escalated_at: null,
    ...overrides,
  };
}

/**
 * Configure the `select().from().where()` chain to return a different set of
 * rows for each call. The worker queries once per severity in THRESHOLDS, in
 * insertion order (critical, warning).
 */
function mockSelectCalls(resultsBySeverity: Record<string, StaleFlag[]>) {
  // The worker iterates Object.keys(THRESHOLDS) in order.
  const ordered = Object.keys(THRESHOLDS).map(
    (sev) => resultsBySeverity[sev] ?? [],
  );

  mockSelect.mockReset();
  mockFrom.mockReset();
  mockSelectWhere.mockReset();

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockSelectWhere });

  ordered.forEach((rows) => {
    mockSelectWhere.mockResolvedValueOnce(rows);
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  // update().set().where() — the `where` call resolves the promise.
  mockUpdate.mockReset();
  mockSet.mockReset();
  mockUpdateWhere.mockReset();
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);

  mockEmitNotificationEvent.mockClear();
  mockEmitNotificationEvent.mockResolvedValue(undefined);
});

describe("checkAndEscalate", () => {
  it("returns escalated=0 when no flags are stale", async () => {
    mockSelectCalls({});

    const result = await checkAndEscalate();

    expect(result).toEqual({ escalated: 0 });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEmitNotificationEvent).not.toHaveBeenCalled();
  });

  it("escalates a stale critical flag and emits a re-notification", async () => {
    const flag = makeFlag({ id: "flag-crit-1" });
    mockSelectCalls({ critical: [flag] });

    const result = await checkAndEscalate();

    expect(result.escalated).toBe(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);

    const updatePayload = mockSet.mock.calls[0][0];
    expect(updatePayload.escalation_count).toBe(1);
    expect(updatePayload.last_escalated_at).toEqual(expect.any(String));
    // Not final — stays open.
    expect(updatePayload.status).toBe("open");

    expect(mockEmitNotificationEvent).toHaveBeenCalledTimes(1);
    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.flag_id).toBe("flag-crit-1");
    expect(event.severity).toBe("critical");
    expect(event.summary.startsWith("ESCALATED (1/3):")).toBe(true);
    expect(event.notify_specialties).toEqual(["nephrology"]);
  });

  it("marks the flag status='escalated' on the final attempt", async () => {
    const flag = makeFlag({
      id: "flag-crit-final",
      escalation_count: MAX_ESCALATIONS - 1, // next escalation is the last
      last_escalated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mockSelectCalls({ critical: [flag] });

    const result = await checkAndEscalate();

    expect(result.escalated).toBe(1);
    const updatePayload = mockSet.mock.calls[0][0];
    expect(updatePayload.escalation_count).toBe(MAX_ESCALATIONS);
    expect(updatePayload.status).toBe("escalated");

    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.summary.startsWith(`ESCALATED (${MAX_ESCALATIONS}/3):`)).toBe(
      true,
    );
  });

  it("handles multiple severities and counts all escalations", async () => {
    const critical = makeFlag({ id: "c-1", severity: "critical" });
    const warning1 = makeFlag({
      id: "w-1",
      severity: "warning",
      category: "care-gap",
    });
    const warning2 = makeFlag({
      id: "w-2",
      severity: "warning",
      category: "trend-concern",
    });

    mockSelectCalls({
      critical: [critical],
      warning: [warning1, warning2],
    });

    const result = await checkAndEscalate();

    expect(result.escalated).toBe(3);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockEmitNotificationEvent).toHaveBeenCalledTimes(3);

    const emittedIds = mockEmitNotificationEvent.mock.calls.map(
      (call) => call[0].flag_id,
    );
    expect(emittedIds).toEqual(["c-1", "w-1", "w-2"]);
  });

  it("records a fresh last_escalated_at timestamp", async () => {
    const flag = makeFlag();
    mockSelectCalls({ critical: [flag] });

    const before = Date.now();
    await checkAndEscalate();
    const after = Date.now();

    const updatePayload = mockSet.mock.calls[0][0];
    const stamped = Date.parse(updatePayload.last_escalated_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("preserves notify_specialties as an array when null/missing", async () => {
    const flag = makeFlag({
      notify_specialties: null as unknown as string[],
    });
    mockSelectCalls({ critical: [flag] });

    await checkAndEscalate();

    const event = mockEmitNotificationEvent.mock.calls[0][0];
    expect(event.notify_specialties).toEqual([]);
  });

  it("exposes the configured thresholds and escalation cap", () => {
    expect(MAX_ESCALATIONS).toBe(3);
    expect(THRESHOLDS.critical).toBe(30 * 60 * 1000);
    expect(THRESHOLDS.warning).toBe(2 * 60 * 60 * 1000);
  });
});
