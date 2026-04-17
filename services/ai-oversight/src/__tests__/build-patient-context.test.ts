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

const nowIso = "2025-06-15T12:00:00.000Z";
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
    expect(ctx.event_timestamp).toBe(stubEvent.timestamp);
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

  // ─── #513 — normalize ISO timestamp comparisons ────────────────────
  it("compares offset-form (-05:00) timestamps identically to equivalent Z-form", async () => {
    // The event timestamp uses UTC Z-form; the diagnosis resolved_date is
    // the identical instant expressed as -05:00 offset. Lex-compare would
    // mis-sort these because "T07:00:00.000-05:00" sorts BEFORE
    // "T12:00:00.000Z" as strings. After Date.parse normalization, both
    // reduce to the same epoch and the diagnosis is correctly excluded.
    const event: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2026-04-16T12:00:00.000Z",
    };

    diagnosesSelect.mockResolvedValue([
      {
        description: "Flu (offset-form resolved_date)",
        icd10_code: "J10.1",
        status: "active",
        onset_date: "2026-04-01T00:00:00.000Z",
        // Same instant as event timestamp, different suffix — equal, so
        // `resolved_date <= eventAt` is true and the diagnosis is excluded.
        resolved_date: "2026-04-16T07:00:00.000-05:00",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_diagnoses).not.toContain("Flu (offset-form resolved_date)");
  });

  it("compares bare-date (YYYY-MM-DD) timestamps correctly against Z-form event", async () => {
    // FHIR + seed data sometimes emit bare dates. Date.parse treats
    // "2026-04-10" as UTC midnight, so a diagnosis with
    // resolved_date="2026-04-10" IS before event_ts=2026-04-16T12:00Z and
    // must be excluded.
    const event: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2026-04-16T12:00:00.000Z",
    };

    diagnosesSelect.mockResolvedValue([
      {
        description: "Bronchitis (bare-date resolved_date)",
        icd10_code: "J40",
        status: "active",
        onset_date: "2026-04-01",
        resolved_date: "2026-04-10", // bare date, before event
        created_at: "2026-04-01T00:00:00.000Z",
      },
      {
        description: "Hypertension (bare-date onset, still active)",
        icd10_code: "I10",
        status: "active",
        onset_date: "2025-01-15", // bare date, well before event
        resolved_date: null,
        created_at: "2025-01-15T00:00:00.000Z",
      },
    ]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_diagnoses).not.toContain(
      "Bronchitis (bare-date resolved_date)",
    );
    expect(ctx.active_diagnoses).toContain(
      "Hypertension (bare-date onset, still active)",
    );
  });

  // ─── #515 — exclude logical retractions ────────────────────────────
  it("excludes a diagnosis with status=entered_in_error even when timestamps say active", async () => {
    const event: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2026-04-16T12:00:00.000Z",
    };

    diagnosesSelect.mockResolvedValue([
      {
        description: "Myocardial infarction (charting mistake)",
        icd10_code: "I21.9",
        status: "entered_in_error", // charting correction
        onset_date: "2025-01-01T00:00:00.000Z",
        resolved_date: null,
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        description: "Breast cancer (chronic, real)",
        icd10_code: "C50.9",
        status: "chronic",
        onset_date: "2025-01-01T00:00:00.000Z",
        resolved_date: null,
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.active_diagnoses).not.toContain(
      "Myocardial infarction (charting mistake)",
    );
    expect(ctx.active_diagnoses).toContain("Breast cancer (chronic, real)");
  });

  it("excludes allergies with verification_status=entered_in_error or refuted", async () => {
    const event: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2026-04-16T12:00:00.000Z",
    };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    allergiesSelect.mockResolvedValue([
      {
        allergen: "penicillin",
        verification_status: "entered_in_error",
        rxnorm_code: "7980",
        severity: "severe",
        reaction: "rash",
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        allergen: "latex",
        verification_status: "refuted",
        rxnorm_code: null,
        severity: "moderate",
        reaction: "contact dermatitis",
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        allergen: "sulfa",
        verification_status: "confirmed",
        rxnorm_code: "10180",
        severity: "severe",
        reaction: "anaphylaxis",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    const allergens = (ctx.allergies ?? []).map((a) => a.allergen);
    expect(allergens).toEqual(["sulfa"]);
  });

  // ─── #674 — exclude entered_in_error lab results ───────────────────
  it("excludes lab results with flag=entered_in_error from recentLabs", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([
      // Retracted lab — charting mistake, must not appear in recent_labs.
      {
        test_name: "ANC",
        value: 200,
        created_at: "2026-04-16T08:00:00.000Z",
        flag: "entered_in_error",
      },
      // Valid lab — should appear.
      {
        test_name: "WBC",
        value: 4.5,
        created_at: "2026-04-16T09:00:00.000Z",
      },
    ]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.recent_labs).toBeDefined();
    expect(ctx.recent_labs).toEqual([{ name: "WBC", value: 4.5 }]);
    // Verify the retracted lab is explicitly absent.
    const labNames = (ctx.recent_labs ?? []).map((l) => l.name);
    expect(labNames).not.toContain("ANC");
  });

  it("returns no recentLabs when ALL lab rows are entered_in_error", async () => {
    const eventAt = "2026-04-16T12:00:00.000Z";
    const event: ClinicalEvent = { ...stubEvent, timestamp: eventAt };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    labsSelect.mockResolvedValue([
      {
        test_name: "ANC",
        value: 200,
        created_at: "2026-04-16T08:00:00.000Z",
        flag: "entered_in_error",
      },
      {
        test_name: "Hemoglobin",
        value: 7.2,
        created_at: "2026-04-16T07:00:00.000Z",
        flag: "entered_in_error",
      },
    ]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect(ctx.recent_labs).toBeUndefined();
  });

  it("keeps allergies with verification_status=null (schema default `unconfirmed`)", async () => {
    // Pre-existing rows may have null verification_status prior to the
    // #515 migration default. They must NOT be treated as retracted.
    const event: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2026-04-16T12:00:00.000Z",
    };

    diagnosesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    allergiesSelect.mockResolvedValue([
      {
        allergen: "peanut",
        verification_status: null,
        rxnorm_code: null,
        severity: "severe",
        reaction: "anaphylaxis",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    labsSelect.mockResolvedValue([]);

    const ctx = await buildPatientContextForRules("p-1", event);

    expect((ctx.allergies ?? []).map((a) => a.allergen)).toEqual(["peanut"]);
  });
});
