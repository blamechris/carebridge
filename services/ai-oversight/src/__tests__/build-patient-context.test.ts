import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db-schema BEFORE importing the module under test.
//
// The real module uses four parallel select() calls inside Promise.all
// (diagnoses, medications, allergies, recent labs join). We return a
// different chain per call via sequenced mockImplementationOnce primings
// inside beforeEach — the top-level selectMock starts empty and is primed
// fresh per test so unconsumed implementations never bleed across tests.
const diagnosesSelect = vi.fn();
const medicationsSelect = vi.fn();
const allergiesSelect = vi.fn();
const labsSelect = vi.fn();
const selectMock = vi.fn();

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ select: selectMock }),
  diagnoses: { patient_id: "patient_id" },
  medications: { patient_id: "patient_id" },
  allergies: { patient_id: "patient_id" },
  patients: {},
  labPanels: { id: "id", patient_id: "patient_id" },
  labResults: {
    panel_id: "panel_id",
    patient_id: "patient_id",
    created_at: "created_at",
    test_name: "test_name",
    value: "value",
  },
  reviewJobs: {},
}));

import { buildPatientContextForRules } from "../services/review-service.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

const nowIso = new Date().toISOString();
const stubEvent: ClinicalEvent = {
  id: "evt-1",
  type: "vital.created",
  patient_id: "p-1",
  timestamp: nowIso,
  data: { chief_complaint: "fever" },
};

describe("buildPatientContextForRules — recent_labs wiring", () => {
  beforeEach(() => {
    // mockReset (not mockClear) — clears the mockImplementationOnce queue too,
    // so each test starts from an empty implementation sequence and tests
    // can't bleed unconsumed implementations into each other.
    selectMock.mockReset();
    diagnosesSelect.mockReset();
    medicationsSelect.mockReset();
    allergiesSelect.mockReset();
    labsSelect.mockReset();

    // Default: empty allergies. Tests that care about allergies override.
    allergiesSelect.mockResolvedValue([]);

    // Re-prime the sequenced mock implementations (they are consumed per call).
    selectMock
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => diagnosesSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => medicationsSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => allergiesSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: () => labsSelect() }),
          }),
        }),
      }));
  });

  it("populates recent_labs from the joined lab_results query", async () => {
    diagnosesSelect.mockResolvedValue([
      { description: "Breast cancer", icd10_code: "C50.9", status: "active" },
    ]);
    medicationsSelect.mockResolvedValue([
      { name: "Cisplatin", status: "active" },
    ]);
    labsSelect.mockResolvedValue([
      { test_name: "ANC", value: 800, created_at: nowIso },
      { test_name: "WBC", value: 2.1, created_at: nowIso },
    ]);

    const ctx = await buildPatientContextForRules("p-1", stubEvent);

    expect(ctx.recent_labs).toBeDefined();
    expect(ctx.recent_labs).toEqual([
      { name: "ANC", value: 800 },
      { name: "WBC", value: 2.1 },
    ]);
    expect(ctx.active_diagnoses).toContain("Breast cancer");
    expect(ctx.active_medications).toContain("Cisplatin");
  });

  it("dedupes recent labs by test_name, keeping the freshest", async () => {
    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    // Ordered desc by created_at — first row wins.
    labsSelect.mockResolvedValue([
      { test_name: "ANC", value: 500, created_at: nowIso },
      { test_name: "ANC", value: 1800, created_at: "2026-04-05T00:00:00Z" },
    ]);

    const ctx = await buildPatientContextForRules("p-1", stubEvent);

    expect(ctx.recent_labs).toEqual([{ name: "ANC", value: 500 }]);
  });

  it("returns recent_labs as undefined when no recent lab rows exist", async () => {
    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", stubEvent);

    expect(ctx.recent_labs).toBeUndefined();
  });

  it("excludes a medication discontinued before the event timestamp", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([
      // Started 10 days before event, ended 1 day before event — inactive at event time.
      {
        name: "Warfarin",
        status: "active", // status is stale (wasn't yet updated to discontinued)
        started_at: "2026-04-06T00:00:00.000Z",
        ended_at: "2026-04-15T00:00:00.000Z",
        created_at: "2026-04-06T00:00:00.000Z",
      },
    ]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_medications).not.toContain("Warfarin");
  });

  it("includes a medication that is discontinued AFTER the event timestamp", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([
      // The TOCTOU scenario: med was active when event was emitted, then
      // discontinued before the review ran. The rules MUST still see it.
      {
        name: "Apixaban",
        status: "discontinued",
        started_at: "2026-04-01T00:00:00.000Z",
        ended_at: "2026-04-16T15:00:00.000Z",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_medications).toContain("Apixaban");
  });

  it("excludes an allergy added after the event timestamp", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    allergiesSelect.mockResolvedValue([
      // Allergy recorded an hour AFTER the event — rule must not retroactively
      // consider it when evaluating the triggering event.
      {
        allergen: "penicillin",
        rxnorm_code: "7980",
        severity: "severe",
        reaction: "rash",
        created_at: "2026-04-16T13:00:00.000Z",
      },
    ]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.allergies).toHaveLength(0);
  });

  it("excludes a diagnosis resolved before the event timestamp", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([
      {
        description: "Strep throat (resolved)",
        icd10_code: "J02.0",
        status: "active", // stale status
        onset_date: "2026-04-01T00:00:00.000Z",
        resolved_date: "2026-04-10T00:00:00.000Z",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_diagnoses).not.toContain("Strep throat (resolved)");
  });

  it("excludes lab results reported after the event timestamp", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([
      // Future lab — must not "leak from the future" into the rule evaluation.
      { test_name: "ANC", value: 900, created_at: "2026-04-16T15:00:00.000Z" },
      // Lab reported before the event — included.
      { test_name: "WBC", value: 2.1, created_at: "2026-04-16T10:00:00.000Z" },
    ]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.recent_labs).toEqual([{ name: "WBC", value: 2.1 }]);
  });
});
