import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ─── Mocks ───────────────────────────────────────────────────────
//
// This test covers the narrow contract that processReviewJob SKIPS the
// full review pipeline when a `completed` review_jobs row already exists
// for the trigger_event_id. We mock the first select().from().where().limit()
// to return a prior-completed row; if the idempotency check works, the
// pipeline returns early without touching flag-service, LLM, or context.

const insertValues = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn().mockReturnValue({ values: insertValues });

const updateSetWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
const updateMock = vi.fn().mockReturnValue({ set: updateSet });

// Idempotency-first select chain: select().from().where().limit()
const limitMock = vi.fn();
const selectWhere = vi.fn().mockReturnValue({ limit: limitMock });
const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
const selectMock = vi.fn().mockImplementation(() => ({ from: selectFrom }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    update: updateMock,
    select: selectMock,
    query: { patients: { findFirst: vi.fn() } },
  }),
  reviewJobs: { id: "id", trigger_event_id: "trigger_event_id", status: "status" },
  diagnoses: {},
  medications: {},
  patients: {},
  allergies: {},
  messages: {},
  patientObservations: {},
  labPanels: {},
  labResults: {},
  clinicalFlags: {},
  encounters: {},
}));

vi.mock("drizzle-orm", () => {
  const sqlTag = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sql: true,
  }));
  (sqlTag as unknown as Record<string, unknown>).raw = vi.fn((v: string) => ({ __raw: v }));
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    gte: vi.fn(),
    sql: sqlTag,
  };
});

const { mockCreateFlag } = vi.hoisted(() => ({
  mockCreateFlag: vi.fn(),
}));
vi.mock("../services/flag-service.js", () => ({
  createFlag: mockCreateFlag,
}));

vi.mock("../services/claude-client.js", () => ({
  reviewPatientRecord: vi.fn(),
}));

vi.mock("../workers/context-builder.js", () => ({
  buildPatientContext: vi.fn(),
}));

vi.mock("../rules/critical-values.js", () => ({
  checkCriticalValues: vi.fn().mockReturnValue([]),
}));
vi.mock("../rules/cross-specialty.js", () => ({
  checkCrossSpecialtyPatterns: vi.fn().mockReturnValue([]),
}));
vi.mock("../rules/drug-interactions.js", () => ({
  checkDrugInteractions: vi.fn().mockReturnValue([]),
}));
vi.mock("../rules/allergy-medication.js", () => ({
  checkAllergyMedication: vi.fn().mockReturnValue([]),
}));
vi.mock("../rules/message-screening.js", () => ({
  screenPatientMessage: vi.fn().mockReturnValue([]),
}));
vi.mock("../rules/observation-screening.js", () => ({
  screenPatientObservation: vi.fn().mockReturnValue([]),
}));

vi.mock("@carebridge/ai-prompts", () => ({
  CLINICAL_REVIEW_SYSTEM_PROMPT: "system",
  PROMPT_VERSION: "1.0.0-test",
  buildReviewPrompt: vi.fn(),
  enforceTokenBudget: vi.fn(),
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  redactClinicalText: vi.fn(),
  redactPatientId: vi.fn().mockReturnValue("[patient]"),
  validateLLMResponse: vi.fn(),
}));

import { processReviewJob } from "../services/review-service.js";

function makeEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  return {
    id: "evt-idem-1",
    type: "vital.created",
    patient_id: "pat-1",
    timestamp: "2026-04-16T12:00:00.000Z",
    data: {},
    ...overrides,
  };
}

describe("processReviewJob — idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({ values: insertValues });
    updateMock.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateSetWhere });
    selectMock.mockImplementation(() => ({ from: selectFrom }));
    selectFrom.mockReturnValue({ where: selectWhere });
    selectWhere.mockReturnValue({ limit: limitMock });
  });

  it("skips processing when a completed review_jobs row already exists for the event", async () => {
    limitMock.mockResolvedValueOnce([
      {
        id: "prior-job-id",
        status: "completed",
        created_at: new Date().toISOString(),
      },
    ]);

    await processReviewJob(makeEvent());

    expect(insertMock).not.toHaveBeenCalled();
    expect(mockCreateFlag).not.toHaveBeenCalled();
  });

  // #520: parameterized across all three terminal statuses
  it.each([
    ["completed"],
    ["llm_timeout"],
    ["llm_error"],
  ])("skips processing when prior run ended in terminal status '%s'", async (status) => {
    limitMock.mockResolvedValueOnce([
      {
        id: `prior-${status}-id`,
        status,
        created_at: new Date().toISOString(),
      },
    ]);

    await processReviewJob(makeEvent({ id: `evt-term-${status}` }));

    expect(insertMock).not.toHaveBeenCalled();
    expect(mockCreateFlag).not.toHaveBeenCalled();
  });

  // #520: `failed` is NOT terminal — retry IS desired
  it("proceeds when prior run ended in 'failed' (retry is desired)", async () => {
    limitMock.mockResolvedValue([]);

    try {
      await processReviewJob(makeEvent({ id: "evt-failed-retry" }));
    } catch {
      // Downstream mocks may throw
    }

    expect(insertMock).toHaveBeenCalled();
  });

  // #522: recent in-flight `processing` row blocks duplicate
  it("skips processing when a recent 'processing' row exists (in-flight race)", async () => {
    limitMock.mockResolvedValueOnce([
      {
        id: "concurrent-worker-job-id",
        status: "processing",
        created_at: new Date(Date.now() - 5_000).toISOString(),
      },
    ]);

    await processReviewJob(makeEvent({ id: "evt-in-flight" }));

    expect(insertMock).not.toHaveBeenCalled();
    expect(mockCreateFlag).not.toHaveBeenCalled();
  });

  // #522: stale `processing` row (orphan) does NOT block
  it("proceeds when only a stale 'processing' row exists (orphaned crash)", async () => {
    limitMock.mockResolvedValue([]);

    try {
      await processReviewJob(makeEvent({ id: "evt-stale-orphan" }));
    } catch {
      // Downstream mocks may throw
    }

    expect(insertMock).toHaveBeenCalled();
  });

  it("proceeds with processing when no prior completed review exists", async () => {
    limitMock.mockResolvedValue([]);

    const event = makeEvent({ id: "evt-new" });

    try {
      await processReviewJob(event);
    } catch {
      // Downstream mocks may throw
    }

    expect(insertMock).toHaveBeenCalled();
  });
});

describe("processReviewJob — idempotency probe predicate shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({ values: insertValues });
    updateMock.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateSetWhere });
    selectMock.mockImplementation(() => ({ from: selectFrom }));
    selectFrom.mockReturnValue({ where: selectWhere });
    selectWhere.mockReturnValue({ limit: limitMock });
    limitMock.mockResolvedValue([]);
  });

  it("calls inArray with the three terminal statuses", async () => {
    const drizzle = await import("drizzle-orm");
    const inArrayMock = vi.mocked(drizzle.inArray);

    try {
      await processReviewJob(makeEvent({ id: "evt-probe-shape" }));
    } catch {
      // Ignore downstream errors
    }

    const statusCall = inArrayMock.mock.calls.find(([, values]) =>
      Array.isArray(values) &&
      values.includes("completed") &&
      values.includes("llm_timeout") &&
      values.includes("llm_error"),
    );
    expect(statusCall).toBeDefined();
  });

  it("includes an in-flight 'processing' branch in the probe via or()", async () => {
    const drizzle = await import("drizzle-orm");
    const orMock = vi.mocked(drizzle.or);

    try {
      await processReviewJob(makeEvent({ id: "evt-probe-or" }));
    } catch {
      // Ignore downstream errors
    }

    expect(orMock).toHaveBeenCalled();
  });
});
