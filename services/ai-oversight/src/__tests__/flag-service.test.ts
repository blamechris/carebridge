import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @carebridge/db-schema before importing flag-service
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  clinicalFlags: {
    patient_id: "patient_id",
    rule_id: "rule_id",
    status: "status",
    category: "category",
    severity: "severity",
    created_at: "created_at",
    trigger_event_ids: "trigger_event_ids",
  },
}));

// Stub @carebridge/notifications so importing flag-service does not pull in
// BullMQ + Redis at module-load time. Without this mock the import-time
// notification queue connection ECONNREFUSEs in CI (no Redis service) and the
// tests time out at 5s.
const { mockEmitNotificationEvent } = vi.hoisted(() => ({
  mockEmitNotificationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@carebridge/notifications", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

import { createFlag } from "../services/flag-service.js";

beforeEach(() => {
  vi.clearAllMocks();

  // Default chain: select().from().where().limit() -> []
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([]);

  // Default chain: insert().values().onConflictDoNothing().returning() -> [record]
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
  // By default, returning() resolves with a single-element array (insert succeeded)
  mockReturning.mockResolvedValue([{ id: "inserted" }]);
});

describe("createFlag", () => {
  const baseFlag = {
    patient_id: "patient-1",
    source: "rules" as const,
    rule_id: "ONCO-VTE-NEURO-001",
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary: "Cancer patient with VTE history presents with new neurological symptom",
    rationale: "Elevated stroke risk",
    suggested_action: "Urgent neurological evaluation recommended.",
    notify_specialties: ["neurology", "hematology"],
    trigger_event_ids: ["evt-1"],
    status: "open" as const,
  };

  it("defaults requires_human_review=true and preserves confidence for ai-review flags", async () => {
    const aiFlag = {
      ...baseFlag,
      source: "ai-review" as const,
      rule_id: undefined,
      confidence: 72,
    };
    const result = await createFlag(aiFlag);
    expect(result.requires_human_review).toBe(true);
    expect(result.confidence).toBe(72);
    const inserted = mockValues.mock.calls[0]?.[0];
    expect(inserted.requires_human_review).toBe(true);
    expect(inserted.confidence).toBe(72);
  });

  it("inserts a new flag when no duplicate exists", async () => {
    // No existing flag found (default mock returns [])
    const result = await createFlag(baseFlag);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      patient_id: "patient-1",
      rule_id: "ONCO-VTE-NEURO-001",
      severity: "critical",
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });

  it("returns existing flag when duplicate rule-based flag exists (same patient_id + rule_id + status=open)", async () => {
    const existingFlag = {
      id: "existing-flag-id",
      ...baseFlag,
      created_at: "2026-01-01T00:00:00.000Z",
    };

    // Mock DB returning an existing flag
    mockLimit.mockResolvedValueOnce([existingFlag]);

    const result = await createFlag(baseFlag);

    // Should NOT insert a new flag
    expect(mockInsert).not.toHaveBeenCalled();
    // Should return the existing one
    expect(result.id).toBe("existing-flag-id");
  });

  it("deduplicates LLM flags within 24h window (same patient_id + category + severity + status=open)", async () => {
    const llmFlag = {
      patient_id: "patient-1",
      source: "ai-review" as const,
      // No rule_id for LLM flags
      severity: "warning" as const,
      category: "cross-specialty" as const,
      summary: "Potential drug interaction detected by LLM",
      rationale: "LLM analysis found a concerning pattern",
      suggested_action: "Review medications",
      notify_specialties: ["pharmacy"],
      trigger_event_ids: ["evt-2"],
      status: "open" as const,
    };

    const existingLlmFlag = {
      id: "existing-llm-flag",
      ...llmFlag,
      created_at: new Date().toISOString(),
    };

    // Mock DB returning an existing LLM flag within the 24h window
    mockLimit.mockResolvedValueOnce([existingLlmFlag]);

    const result = await createFlag(llmFlag);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(result.id).toBe("existing-llm-flag");
  });

  it("returns existing flag when DB unique constraint prevents duplicate insert (TOCTOU race)", async () => {
    // Simulate the race: application-level SELECT found nothing, but a
    // concurrent worker inserted between our SELECT and INSERT, so
    // ON CONFLICT DO NOTHING fires and returning() yields [].
    mockReturning.mockResolvedValueOnce([]);

    // The follow-up SELECT to fetch the winner's flag
    const winnerFlag = {
      id: "winner-flag-id",
      ...baseFlag,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    // Call sequence: (1) trigger_event_id idempotency check -> [],
    // (2) app-level rule dedup -> [], (3) post-conflict fetch -> [winnerFlag]
    mockLimit
      .mockResolvedValueOnce([])           // idempotency pre-check
      .mockResolvedValueOnce([])           // initial dedup check
      .mockResolvedValueOnce([winnerFlag]); // post-conflict fetch

    const result = await createFlag(baseFlag);

    expect(result.id).toBe("winner-flag-id");
    // Insert was attempted (but suppressed by DB constraint)
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("returns existing flag when DB unique constraint prevents duplicate LLM flag insert", async () => {
    const llmFlag = {
      patient_id: "patient-1",
      source: "ai-review" as const,
      severity: "warning" as const,
      category: "cross-specialty" as const,
      summary: "LLM finding",
      rationale: "Analysis",
      suggested_action: "Review",
      notify_specialties: ["pharmacy"],
      trigger_event_ids: ["evt-4"],
      status: "open" as const,
    };

    const winnerFlag = {
      id: "winner-llm-flag",
      ...llmFlag,
      created_at: new Date().toISOString(),
    };

    // ON CONFLICT DO NOTHING returns empty
    mockReturning.mockResolvedValueOnce([]);
    // (1) idempotency pre-check -> []; (2) app-level LLM dedup -> [];
    // (3) post-conflict fetch -> [winnerFlag]
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([winnerFlag]);

    const result = await createFlag(llmFlag);

    expect(result.id).toBe("winner-llm-flag");
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("creates a new LLM flag when no duplicate exists within 24h window", async () => {
    const llmFlag = {
      patient_id: "patient-1",
      source: "ai-review" as const,
      severity: "warning" as const,
      category: "cross-specialty" as const,
      summary: "New LLM finding",
      rationale: "Analysis",
      suggested_action: "Review",
      notify_specialties: ["pharmacy"],
      trigger_event_ids: ["evt-3"],
      status: "open" as const,
    };

    // No existing flag found (default)
    const result = await createFlag(llmFlag);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(result.id).toBeDefined();
    expect(result.patient_id).toBe("patient-1");
  });

  it("emits a notification event when a new flag is created with notify_specialties", async () => {
    const result = await createFlag(baseFlag);

    expect(mockEmitNotificationEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitNotificationEvent).toHaveBeenCalledWith({
      flag_id: result.id,
      patient_id: "patient-1",
      severity: "critical",
      category: "cross-specialty",
      summary: baseFlag.summary,
      suggested_action: baseFlag.suggested_action,
      notify_specialties: ["neurology", "hematology"],
      source: "rules",
      created_at: result.created_at,
    });
  });

  it("emits a notification event with empty notify_specialties when none provided", async () => {
    const flagNoSpecialties = {
      ...baseFlag,
      notify_specialties: [] as string[],
    };

    const result = await createFlag(flagNoSpecialties);

    expect(mockEmitNotificationEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitNotificationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flag_id: result.id,
        notify_specialties: [],
      }),
    );
  });

  it("returns existing flag when a trigger_event_id matches, regardless of status", async () => {
    // A prior flag — already resolved — was cited against evt-99. When an
    // event replay arrives citing evt-99 again, createFlag must return the
    // prior flag instead of inserting a duplicate. The open-status partial
    // indexes would miss this because the prior flag is no longer open.
    const replayedFlag = {
      ...baseFlag,
      trigger_event_ids: ["evt-99"],
    };

    const resolvedExistingFlag = {
      id: "prior-resolved-flag",
      ...replayedFlag,
      status: "resolved",
      trigger_event_ids: ["evt-99"],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    // First (and only) SELECT is the trigger-event-id idempotency check.
    mockLimit.mockResolvedValueOnce([resolvedExistingFlag]);

    const result = await createFlag(replayedFlag);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEmitNotificationEvent).not.toHaveBeenCalled();
    expect(result.id).toBe("prior-resolved-flag");
  });

  it("does not short-circuit when trigger_event_ids is empty", async () => {
    // Some callers may legitimately omit trigger_event_ids (e.g. manual
    // flags). The idempotency check must not fire in that case — otherwise
    // no flags could ever be created without an event id.
    const manualFlag = { ...baseFlag, trigger_event_ids: [] };

    const result = await createFlag(manualFlag);

    // Insert proceeds via the rule-based dedup path.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(result.id).toBeDefined();
  });

  it("does not emit a notification event when a duplicate flag is returned", async () => {
    const existingFlag = {
      id: "existing-flag-id",
      ...baseFlag,
      created_at: "2026-01-01T00:00:00.000Z",
    };

    // Mock DB returning an existing flag
    mockLimit.mockResolvedValueOnce([existingFlag]);

    await createFlag(baseFlag);

    expect(mockEmitNotificationEvent).not.toHaveBeenCalled();
  });
});
