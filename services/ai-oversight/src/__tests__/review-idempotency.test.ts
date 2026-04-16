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

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
}));

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
    // First select.limit() call is the idempotency probe — return a prior
    // completed row. No other mocks need priming because the function
    // returns before touching anything else.
    limitMock.mockResolvedValueOnce([
      { id: "prior-job-id", status: "completed" },
    ]);

    await processReviewJob(makeEvent());

    // No insert, no flag creation, no update.
    expect(insertMock).not.toHaveBeenCalled();
    expect(mockCreateFlag).not.toHaveBeenCalled();
  });

  it("proceeds with processing when no prior completed review exists", async () => {
    // Idempotency probe returns [] — no prior run. All downstream selects
    // (patient context builder, encounters, etc.) also get [] to keep the
    // pipeline unblocked through to the insert.
    limitMock.mockResolvedValue([]);

    // The downstream pipeline still needs usable mocks — at minimum the
    // insert into review_jobs must be reached. Everything after that is
    // short-circuited by the empty rule results mocked above.
    const event = makeEvent({ id: "evt-new" });

    // We expect this NOT to return early; the job row insert is proof.
    try {
      await processReviewJob(event);
    } catch {
      // The rest of the pipeline is stubbed lightly — exceptions from
      // context-builder etc. are acceptable; we only care that we got past
      // the idempotency guard.
    }

    expect(insertMock).toHaveBeenCalled();
  });
});
