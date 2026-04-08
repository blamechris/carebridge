import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @carebridge/db-schema before importing flag-service
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();

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
  },
}));

import { createFlag } from "../services/flag-service.js";

beforeEach(() => {
  vi.clearAllMocks();

  // Default chain: select().from().where().limit() -> []
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([]);

  // Default chain: insert().values() -> void
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue(undefined);
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
});
