/**
 * Verifies checkMedicationReconciliation is invoked by the review-service pipeline.
 *
 * Issue #983: the rule was fully implemented (full DB queries, clinical-logic
 * body, flag construction) but never imported or called from review-service.
 * This test was missing — without it the orphan-rule pattern was undetectable
 * by CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { checkMedicationReconciliationMock } = vi.hoisted(() => ({
  checkMedicationReconciliationMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("drizzle-orm", () => {
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: true,
    strings: [...strings],
    values,
  });
  sqlTag.raw = (value: string) => ({ __raw: value });
  return {
    sql: sqlTag,
    eq: vi.fn(),
    ne: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    gt: vi.fn(),
  };
});

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
  reviewJobs: { id: "id", trigger_event_id: "trigger_event_id", status: "status", created_at: "created_at" },
  diagnoses: { patient_id: "patient_id", status: "status", onset_date: "onset_date", resolved_date: "resolved_date" },
  medications: { patient_id: "patient_id", status: "status", started_at: "started_at", ended_at: "ended_at", encounter_id: "encounter_id" },
  patients: {},
  allergies: { patient_id: "patient_id", created_at: "created_at", verification_status: "verification_status" },
  allergyOverrides: {},
  messages: {},
  patientObservations: {},
  labPanels: {},
  labResults: { created_at: "created_at" },
  clinicalFlags: {},
  encounters: { id: "id", patient_id: "patient_id", status: "status", start_time: "start_time" },
}));

vi.mock("../services/flag-service.js", () => ({ createFlag: vi.fn() }));
vi.mock("../services/claude-client.js", () => ({ reviewPatientRecord: vi.fn() }));
vi.mock("../workers/context-builder.js", () => ({ buildPatientContext: vi.fn() }));
vi.mock("../rules/critical-values.js", () => ({ checkCriticalValues: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/cross-specialty.js", () => ({ checkCrossSpecialtyPatterns: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/contraindications.js", () => ({ checkContraindications: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/age-stratified.js", () => ({ checkAgeStratifiedRules: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/drug-interactions.js", () => ({ checkDrugInteractions: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/allergy-medication.js", () => ({ checkAllergyMedication: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/medication-daily-dose.js", () => ({ checkMedicationDailyDose: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/message-screening.js", () => ({ screenPatientMessage: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/observation-screening.js", () => ({ screenPatientObservation: vi.fn().mockReturnValue([]) }));
vi.mock("../rules/medication-reconciliation.js", () => ({
  checkMedicationReconciliation: checkMedicationReconciliationMock,
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
    id: "evt-reconcile-1",
    type: "medication.updated",
    patient_id: "pat-1",
    timestamp: "2026-05-21T12:00:00.000Z",
    data: { encounter_id: "enc-1", new_status: "finished" },
    ...overrides,
  };
}

describe("review-service wires checkMedicationReconciliation (#983)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkMedicationReconciliationMock.mockResolvedValue([]);
    insertMock.mockReturnValue({ values: insertValues });
    updateMock.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateSetWhere });
    selectMock.mockImplementation(() => ({ from: selectFrom }));
    selectFrom.mockReturnValue({ where: selectWhere });
    selectWhere.mockReturnValue({ limit: limitMock });
    limitMock.mockResolvedValue([]);
  });

  it("invokes checkMedicationReconciliation during processReviewJob", async () => {
    try {
      await processReviewJob(makeEvent());
    } catch {
      // Downstream mocks may throw on later pipeline steps — we only assert the rule was invoked.
    }
    expect(checkMedicationReconciliationMock).toHaveBeenCalledTimes(1);
    expect(checkMedicationReconciliationMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt-reconcile-1", patient_id: "pat-1" }),
    );
  });

});
