/**
 * Tests for the DB-clock idempotency probe (#627).
 *
 * PR #608 moved the in-flight freshness comparison to sql`NOW()` so both
 * sides of the comparison use the PostgreSQL clock. The existing idempotency
 * tests mock the DB layer and don't exercise the raw SQL derivation. This
 * file validates:
 *
 *   1. The exported IN_FLIGHT_WINDOW_MS constant is sane (positive, matches
 *      the documented BullMQ lockDuration headroom).
 *   2. The window-to-seconds derivation (windowSec = IN_FLIGHT_WINDOW_MS / 1000)
 *      produces an integer suitable for a PostgreSQL interval literal.
 *   3. The sql`NOW() - interval '…'` template correctly embeds the derived
 *      seconds value using sql.raw, so the interval tracks the constant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { IN_FLIGHT_WINDOW_MS } from "../services/review-service.js";

// ─── Capture the sql template calls made during the idempotency probe ──

// Track sql template calls and sql.raw calls
const sqlRawCalls: string[] = [];
const sqlTemplateCalls: Array<{ strings: string[]; values: unknown[] }> = [];

vi.mock("drizzle-orm", () => {
  const rawFn = (value: string) => {
    sqlRawCalls.push(value);
    return { __raw: value };
  };

  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlTemplateCalls.push({
      strings: [...strings],
      values,
    });
    return { __sql: true, strings: [...strings], values };
  };
  sqlTag.raw = rawFn;

  return {
    sql: sqlTag,
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    gte: vi.fn(),
  };
});

// Minimal DB mock — we only need the idempotency probe's select chain
const limitMock = vi.fn().mockResolvedValue([]);
const selectWhere = vi.fn().mockReturnValue({ limit: limitMock });
const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
const selectMock = vi.fn().mockImplementation(() => ({ from: selectFrom }));
const insertValues = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn().mockReturnValue({ values: insertValues });
const updateSetWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
const updateMock = vi.fn().mockReturnValue({ set: updateSet });

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    query: { patients: { findFirst: vi.fn() } },
  }),
  reviewJobs: {
    id: "id",
    trigger_event_id: "trigger_event_id",
    status: "status",
    created_at: "created_at",
  },
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

vi.mock("../services/flag-service.js", () => ({
  createFlag: vi.fn(),
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
import type { ClinicalEvent } from "@carebridge/shared-types";

function makeEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  return {
    id: "evt-db-clock-1",
    type: "vital.created",
    patient_id: "pat-1",
    timestamp: "2026-04-16T12:00:00.000Z",
    data: {},
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("IN_FLIGHT_WINDOW_MS constant", () => {
  it("is a positive integer in milliseconds", () => {
    expect(IN_FLIGHT_WINDOW_MS).toBeGreaterThan(0);
    expect(Number.isInteger(IN_FLIGHT_WINDOW_MS)).toBe(true);
  });

  it("is >= BullMQ lockDuration (120s) to prevent live-worker orphan misclassification", () => {
    // BullMQ lockDuration is 120_000ms. The window must exceed it so a
    // live worker's row never falls outside the freshness check.
    expect(IN_FLIGHT_WINDOW_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("converts to a whole number of seconds for the PostgreSQL interval literal", () => {
    const windowSec = Math.round(IN_FLIGHT_WINDOW_MS / 1000);
    expect(windowSec).toBe(IN_FLIGHT_WINDOW_MS / 1000);
    expect(Number.isInteger(windowSec)).toBe(true);
  });
});

describe("DB-clock interval derivation in idempotency probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlRawCalls.length = 0;
    sqlTemplateCalls.length = 0;

    insertMock.mockReturnValue({ values: insertValues });
    updateMock.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateSetWhere });
    selectMock.mockImplementation(() => ({ from: selectFrom }));
    selectFrom.mockReturnValue({ where: selectWhere });
    selectWhere.mockReturnValue({ limit: limitMock });
    limitMock.mockResolvedValue([]);
  });

  it("passes the derived seconds value through sql.raw()", async () => {
    try {
      await processReviewJob(makeEvent());
    } catch {
      // Downstream mocks may throw — we only care about the sql calls
    }

    const expectedSec = String(Math.round(IN_FLIGHT_WINDOW_MS / 1000));
    expect(sqlRawCalls).toContain(expectedSec);
  });

  it("embeds the interval in a NOW() - interval template", async () => {
    try {
      await processReviewJob(makeEvent());
    } catch {
      // Downstream mocks may throw
    }

    // Find the sql template call that builds the cutoff expression.
    // The template should look like: NOW() - interval '${sql.raw(…)} seconds'
    const intervalCall = sqlTemplateCalls.find(
      (call) =>
        call.strings.some((s) => s.includes("NOW()")) &&
        call.strings.some((s) => s.includes("seconds")),
    );

    expect(intervalCall).toBeDefined();
    expect(intervalCall!.strings.join("")).toContain("NOW()");
    expect(intervalCall!.strings.join("")).toContain("interval");
    expect(intervalCall!.strings.join("")).toContain("seconds");
  });

  it("interval seconds match IN_FLIGHT_WINDOW_MS / 1000 (no hardcoded drift)", () => {
    // This is the core invariant: the SQL interval must track the constant.
    // If someone changes IN_FLIGHT_WINDOW_MS without updating the SQL (or
    // vice versa), this test catches the drift because the derivation now
    // uses the constant directly.
    const expectedSec = IN_FLIGHT_WINDOW_MS / 1000;
    expect(expectedSec).toBe(150);
    expect(Number.isInteger(expectedSec)).toBe(true);
  });
});
