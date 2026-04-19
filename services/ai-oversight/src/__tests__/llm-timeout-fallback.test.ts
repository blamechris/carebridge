import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock setup ──────────────────────────────────────────────────
// Mock all external dependencies before importing the module under test.

// Build a deeply-chainable mock for Drizzle's query builder.
// Every method returns `this` so chains like select().from().innerJoin().where()
// all resolve without errors.
function makeChain(resolvedValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_target, prop) {
      if (prop === "then") {
        // Make it thenable so `await` resolves to the configured value
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (typeof prop === "symbol") return undefined;
      return vi.fn().mockReturnValue(self);
    },
  });
  return self;
}

const mockInsert = vi.fn().mockReturnValue(makeChain([{ id: "flag-fallback-id" }]));

const mockSetFn = vi.fn().mockReturnValue(makeChain(undefined));
const mockUpdate = vi.fn().mockReturnValue({
  set: mockSetFn,
});

const mockSelect = vi.fn().mockReturnValue(makeChain([]));

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  select: mockSelect,
  query: {
    patients: {
      findFirst: vi.fn().mockResolvedValue({ name: "Test Patient" }),
    },
  },
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  reviewJobs: { id: "id", patient_id: "patient_id", status: "status" },
  clinicalFlags: {
    id: "id",
    patient_id: "patient_id",
    rule_id: "rule_id",
    status: "status",
    category: "category",
    severity: "severity",
    summary: "summary",
    created_at: "created_at",
    source: "source",
  },
  diagnoses: { patient_id: "patient_id", status: "status", onset_date: "onset_date", resolved_date: "resolved_date" },
  medications: { patient_id: "patient_id", status: "status", started_at: "started_at", ended_at: "ended_at" },
  patients: { id: "id" },
  allergies: { patient_id: "patient_id", created_at: "created_at", verification_status: "verification_status" },
  allergyOverrides: {
    patient_id: "patient_id",
    allergy_id: "allergy_id",
    flag_id: "flag_id",
    override_reason: "override_reason",
    overridden_at: "overridden_at",
  },
  messages: { id: "id", body: "body" },
  patientObservations: { id: "id", description: "description" },
  labPanels: { id: "id", patient_id: "patient_id" },
  labResults: {
    panel_id: "panel_id",
    test_name: "test_name",
    value: "value",
    created_at: "created_at",
  },
  encounters: { patient_id: "patient_id", status: "status" },
  vitals: { patient_id: "patient_id" },
  careTeamAssignments: { patient_id: "patient_id", user_id: "user_id" },
}));

vi.mock("drizzle-orm", () => {
  const sqlTag = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sql: true,
  }));
  (sqlTag as unknown as Record<string, unknown>).raw = vi.fn((v: string) => ({ __raw: v }));
  return {
    eq: vi.fn((...args: unknown[]) => args),
    ne: vi.fn((...args: unknown[]) => args),
    desc: vi.fn((col: unknown) => col),
    gte: vi.fn((...args: unknown[]) => args),
    lte: vi.fn((...args: unknown[]) => args),
    gt: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
    or: vi.fn((...args: unknown[]) => args),
    inArray: vi.fn((...args: unknown[]) => args),
    sql: sqlTag,
  };
});

vi.mock("@carebridge/ai-prompts", () => ({
  CLINICAL_REVIEW_SYSTEM_PROMPT: "system prompt",
  PROMPT_VERSION: "v1",
  buildReviewPrompt: vi.fn(() => "review prompt"),
  enforceTokenBudget: vi.fn((prompt: string) => ({
    prompt,
    truncated: false,
    originalTokens: 100,
    finalTokens: 100,
    sectionsRemoved: [],
  })),
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  redactClinicalText: vi.fn((text: string) => ({
    redactedText: text,
    auditTrail: { fieldsRedacted: 0, providersRedacted: 0, agesRedacted: 0, freeTextSanitized: 0 },
  })),
  validateLLMResponse: vi.fn(() => ({
    ok: true,
    flags: [],
    warnings: [],
  })),
  assertPromptSanitized: vi.fn(),
  SanitizationError: class SanitizationError extends Error {},
}));

const mockReviewPatientRecord = vi.fn();
vi.mock("../services/claude-client.js", () => ({
  reviewPatientRecord: mockReviewPatientRecord,
}));

const mockCreateFlag = vi.fn().mockResolvedValue({ id: "flag-id-fallback" });
vi.mock("../services/flag-service.js", () => ({
  createFlag: mockCreateFlag,
}));

const mockBuildPatientContext = vi.fn().mockResolvedValue({
  patient: { age: 55 },
  care_team: [],
});
vi.mock("../workers/context-builder.js", () => ({
  buildPatientContext: mockBuildPatientContext,
}));

vi.mock("@carebridge/notifications", () => ({
  emitNotificationEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import module under test ────────────────────────────────────

const { processReviewJob } = await import("../services/review-service.js");

// ─── Test data ───────────────────────────────────────────────────

function makeClinicalEvent(overrides?: Record<string, unknown>) {
  return {
    id: "event-001",
    type: "vital.created" as const,
    patient_id: "patient-001",
    data: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("LLM timeout/outage fallback handling", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Reset mockDb chained calls
    mockInsert.mockReturnValue(makeChain([{ id: "flag-fallback-id" }]));
    mockSetFn.mockReturnValue(makeChain(undefined));
    mockUpdate.mockReturnValue({ set: mockSetFn });
    mockSelect.mockReturnValue(makeChain([]));

    // Re-set mocks cleared by vi.clearAllMocks()
    mockBuildPatientContext.mockResolvedValue({
      patient: { age: 55 },
      care_team: [],
    });
    mockCreateFlag.mockResolvedValue({ id: "flag-id-fallback" });
    mockDb.query.patients.findFirst.mockResolvedValue({ name: "Test Patient" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a fallback flag when the Claude API times out", async () => {
    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("Claude API call failed after 3 attempts: APIConnectionError — request timed out"),
    );

    await processReviewJob(makeClinicalEvent());

    // Should have created a fallback flag
    expect(mockCreateFlag).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: "patient-001",
        source: "ai-review",
        severity: "info",
        category: "care-gap",
        summary: expect.stringContaining("AI review unavailable"),
        requires_human_review: false,
      }),
    );
  });

  it("sets review job status to llm_timeout on timeout errors", async () => {
    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("request timed out"),
    );

    await processReviewJob(makeClinicalEvent());

    // mockSetFn captures all db.update().set() calls. The last one is the
    // final status update (prior ones are redacted_prompt persistence).
    const lastCall = mockSetFn.mock.calls[mockSetFn.mock.calls.length - 1][0];
    expect(lastCall).toEqual(
      expect.objectContaining({
        status: "llm_timeout",
        error: expect.stringContaining("timed out"),
      }),
    );
  });

  it("sets review job status to llm_error on non-timeout API failures", async () => {
    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("Claude API call failed (non-transient): AuthenticationError status=401"),
    );

    await processReviewJob(makeClinicalEvent());

    const lastCall = mockSetFn.mock.calls[mockSetFn.mock.calls.length - 1][0];
    expect(lastCall).toEqual(
      expect.objectContaining({
        status: "llm_error",
      }),
    );
  });

  it("does not throw when LLM fails — job completes gracefully", async () => {
    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("ETIMEDOUT"),
    );

    // Should NOT throw
    await expect(processReviewJob(makeClinicalEvent())).resolves.toBeUndefined();
  });

  it("logs the timeout with event context", async () => {
    const event = makeClinicalEvent({
      id: "evt-timeout-test",
      type: "lab.resulted",
      patient_id: "patient-timeout",
    });

    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("request timed out"),
    );

    await processReviewJob(event);

    const errorLogs = errorSpy.mock.calls.map((args) => args.join(" "));
    const relevantLog = errorLogs.find((log) =>
      log.includes("LLM review failed"),
    );
    expect(relevantLog).toBeDefined();
    expect(relevantLog).toContain("llm_timeout");
    expect(relevantLog).toContain("patient-timeout");
    expect(relevantLog).toContain("lab.resulted");
  });

  it("fallback flag summary mentions deterministic rules and deferred LLM review", async () => {
    mockReviewPatientRecord.mockRejectedValueOnce(
      new Error("ECONNABORTED"),
    );

    await processReviewJob(makeClinicalEvent());

    const fallbackCall = mockCreateFlag.mock.calls.find(
      (call: unknown[]) => (call[0] as { summary?: string })?.summary?.includes("AI review unavailable"),
    );
    expect(fallbackCall).toBeDefined();
    const summary = (fallbackCall![0] as { summary: string }).summary;
    expect(summary).toContain("deterministic rules applied");
    expect(summary).toContain("LLM review deferred");
  });

  it("still succeeds normally when LLM call works", async () => {
    mockReviewPatientRecord.mockResolvedValueOnce('{"flags": []}');

    await expect(processReviewJob(makeClinicalEvent())).resolves.toBeUndefined();

    // Should NOT have created a fallback flag with "AI review unavailable"
    const fallbackCalls = mockCreateFlag.mock.calls.filter(
      (call) =>
        call[0]?.summary?.includes("AI review unavailable"),
    );
    expect(fallbackCalls).toHaveLength(0);
  });
});
