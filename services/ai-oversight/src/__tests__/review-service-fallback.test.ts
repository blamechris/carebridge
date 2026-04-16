import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ─── Mocks ───────────────────────────────────────────────────────

// Track flags created via the flag-service mock
const createdFlags: Array<Record<string, unknown>> = [];

vi.mock("@carebridge/db-schema", () => {
  // Helper: builds a chain that is both a Promise<[]> and has chainable methods
  function makeQueryChain(): unknown {
    const resolved = Promise.resolve([]);
    const chain: Record<string, unknown> = {
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
      finally: resolved.finally.bind(resolved),
      where: vi.fn().mockImplementation(() => makeQueryChain()),
      from: vi.fn().mockImplementation(() => makeQueryChain()),
      innerJoin: vi.fn().mockImplementation(() => makeQueryChain()),
      limit: vi.fn().mockImplementation(() => makeQueryChain()),
      orderBy: vi.fn().mockImplementation(() => makeQueryChain()),
    };
    return chain;
  }

  const fakeDb = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockImplementation(() => makeQueryChain()),
    query: {
      patients: {
        findFirst: vi.fn().mockResolvedValue({ name: "Test Patient" }),
      },
    },
  };
  return {
    getDb: () => fakeDb,
    reviewJobs: {},
    diagnoses: {},
    medications: {},
    patients: {},
    allergies: {},
    messages: {},
    patientObservations: {},
    labPanels: {},
    labResults: {},
    clinicalFlags: {},
    encounters: {
      patient_id: "patient_id",
      location: "location",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  gte: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
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

vi.mock("../rules/message-screening.js", () => ({
  screenPatientMessage: vi.fn().mockReturnValue([]),
}));

vi.mock("../rules/observation-screening.js", () => ({
  screenPatientObservation: vi.fn().mockReturnValue([]),
}));

vi.mock("../rules/allergy-medication.js", () => ({
  checkAllergyMedication: vi.fn().mockReturnValue([]),
}));

vi.mock("../workers/context-builder.js", () => ({
  buildPatientContext: vi.fn().mockResolvedValue({
    patient: { age: 55, sex: "M", active_diagnoses: [], allergies: [] },
    active_medications: [],
    latest_vitals: {},
    recent_labs: [],
    triggering_event: { type: "vital.created", summary: "test", detail: "test" },
    recent_flags: [],
    care_team: [],
  }),
}));

vi.mock("@carebridge/ai-prompts", () => ({
  CLINICAL_REVIEW_SYSTEM_PROMPT: "system prompt",
  PROMPT_VERSION: "1.0.0-test",
  buildReviewPrompt: vi.fn().mockReturnValue("test prompt"),
  enforceTokenBudget: vi.fn().mockReturnValue({
    prompt: "test prompt",
    truncated: false,
    originalTokens: 100,
    finalTokens: 100,
    sectionsRemoved: [],
  }),
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  redactClinicalText: vi.fn().mockReturnValue({
    redactedText: "redacted prompt",
    auditTrail: { fieldsRedacted: 0, providersRedacted: 0, agesRedacted: 0, freeTextSanitized: 0 },
  }),
  validateLLMResponse: vi.fn(),
  assertPromptSanitized: vi.fn(),
}));

// Mock claude-client to return controllable responses
vi.mock("../services/claude-client.js", () => ({
  reviewPatientRecord: vi.fn(),
}));

// Mock flag-service to track created flags
vi.mock("../services/flag-service.js", () => ({
  createFlag: vi.fn().mockImplementation((flag) => {
    const created = { id: crypto.randomUUID(), ...flag, created_at: new Date().toISOString() };
    createdFlags.push(created);
    return Promise.resolve(created);
  }),
}));

vi.mock("@carebridge/notifications", () => ({
  emitNotificationEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import after mocks ─────────────────────────────────────────

import { processReviewJob } from "../services/review-service.js";
import { reviewPatientRecord } from "../services/claude-client.js";
import { validateLLMResponse } from "@carebridge/phi-sanitizer";

const mockReviewPatientRecord = reviewPatientRecord as ReturnType<typeof vi.fn>;
const mockValidateLLMResponse = validateLLMResponse as ReturnType<typeof vi.fn>;

// ─── Test fixtures ──────────────────────────────────────────────

function makeClinicalEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  return {
    id: "evt-001",
    patient_id: "patient-001",
    type: "vital.created",
    data: { notes: "routine vitals" },
    created_at: new Date().toISOString(),
    ...overrides,
  } as ClinicalEvent;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("processReviewJob — malformed LLM response fallback", () => {
  beforeEach(() => {
    createdFlags.length = 0;
    vi.clearAllMocks();
  });

  it("creates a fallback warning flag when LLM response is invalid JSON", async () => {
    mockReviewPatientRecord.mockResolvedValue("This is not JSON at all");
    mockValidateLLMResponse.mockReturnValue({
      ok: false,
      error: "Invalid JSON: Unexpected token 'T', \"This is n\"... is not valid JSON",
    });

    const event = makeClinicalEvent();
    await processReviewJob(event);

    // Should NOT throw — the job should complete
    const fallbackFlags = createdFlags.filter(
      (f) => f.summary === "AI review could not be completed — LLM response was malformed",
    );
    expect(fallbackFlags).toHaveLength(1);

    const fallback = fallbackFlags[0];
    expect(fallback.severity).toBe("warning");
    expect(fallback.category).toBe("care-gap");
    expect(fallback.source).toBe("ai-review");
    expect(fallback.requires_human_review).toBe(true);
    expect(fallback.rationale).toContain("Invalid JSON");
    expect(fallback.rationale).toContain(event.id);
  });

  it("creates a fallback flag when LLM returns non-array JSON", async () => {
    mockReviewPatientRecord.mockResolvedValue('{"not": "an array"}');
    mockValidateLLMResponse.mockReturnValue({
      ok: false,
      error: "Response must be a JSON array",
    });

    const event = makeClinicalEvent();
    await processReviewJob(event);

    const fallbackFlags = createdFlags.filter(
      (f) => f.summary === "AI review could not be completed — LLM response was malformed",
    );
    expect(fallbackFlags).toHaveLength(1);
    expect(fallbackFlags[0].rationale).toContain("Response must be a JSON array");
  });

  it("creates a fallback flag when LLM returns flags with invalid schema", async () => {
    mockReviewPatientRecord.mockResolvedValue(
      '[{"severity": "extreme", "summary": "test"}]',
    );
    mockValidateLLMResponse.mockReturnValue({
      ok: false,
      error: 'Flag[0]: invalid severity "extreme" (must be one of: critical, warning, info)',
    });

    const event = makeClinicalEvent();
    await processReviewJob(event);

    const fallbackFlags = createdFlags.filter(
      (f) => f.summary === "AI review could not be completed — LLM response was malformed",
    );
    expect(fallbackFlags).toHaveLength(1);
    expect(fallbackFlags[0].rationale).toContain("invalid severity");
  });

  it("does NOT throw when LLM response parsing fails", async () => {
    mockReviewPatientRecord.mockResolvedValue("completely garbled output!!!");
    mockValidateLLMResponse.mockReturnValue({
      ok: false,
      error: "Invalid JSON: Unexpected token 'c'",
    });

    const event = makeClinicalEvent();
    // processReviewJob should resolve, not reject
    await expect(processReviewJob(event)).resolves.toBeUndefined();
  });

  it("still processes valid LLM responses normally", async () => {
    mockReviewPatientRecord.mockResolvedValue("[]");
    mockValidateLLMResponse.mockReturnValue({
      ok: true,
      flags: [],
      warnings: [],
    });

    const event = makeClinicalEvent();
    await processReviewJob(event);

    // No fallback flags should be created for valid responses
    const fallbackFlags = createdFlags.filter(
      (f) => f.summary === "AI review could not be completed — LLM response was malformed",
    );
    expect(fallbackFlags).toHaveLength(0);
  });

  it("includes model_id and prompt_version on the fallback flag", async () => {
    mockReviewPatientRecord.mockResolvedValue("bad response");
    mockValidateLLMResponse.mockReturnValue({
      ok: false,
      error: "Invalid JSON",
    });

    const event = makeClinicalEvent();
    await processReviewJob(event);

    const fallbackFlags = createdFlags.filter(
      (f) => f.summary === "AI review could not be completed — LLM response was malformed",
    );
    expect(fallbackFlags[0].model_id).toBe("claude-sonnet-4-6");
    expect(fallbackFlags[0].prompt_version).toBe("1.0.0-test");
  });
});
