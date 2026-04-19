/**
 * Tests for age-context enrichment in buildPatientContextForRules (#236).
 *
 * Uses a dedicated mock set so `db.query.patients.findFirst` is stubbed at
 * module load. The primary build-patient-context test suite deliberately
 * only mocks `db.select()` (and relies on the optional-chaining safety net
 * in review-service.ts for db.query). Here we want to drive the age-
 * enrichment branch end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const diagnosesSelect = vi.fn();
const medicationsSelect = vi.fn();
const allergiesSelect = vi.fn();
const labsSelect = vi.fn();
const overridesSelect = vi.fn();
const selectMock = vi.fn();
const patientFindFirst = vi.fn();

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    select: selectMock,
    query: { patients: { findFirst: patientFindFirst } },
  }),
  diagnoses: {
    patient_id: "patient_id",
    status: "status",
    onset_date: "onset_date",
    resolved_date: "resolved_date",
  },
  medications: {
    patient_id: "patient_id",
    status: "status",
    started_at: "started_at",
    ended_at: "ended_at",
  },
  allergies: {
    patient_id: "patient_id",
    created_at: "created_at",
    verification_status: "verification_status",
  },
  // #233 — review-service.ts now queries allergy_overrides left-joined with
  // clinical_flags. Both table shims are required at mock-load time so the
  // Drizzle query builder doesn't trip over `undefined` column references.
  allergyOverrides: {
    patient_id: "patient_id",
    allergy_id: "allergy_id",
    flag_id: "flag_id",
    override_reason: "override_reason",
    overridden_at: "overridden_at",
  },
  clinicalFlags: {
    id: "id",
    summary: "summary",
  },
  patients: { id: "patients.id" },
  labPanels: { id: "id", patient_id: "patient_id" },
  labResults: {
    panel_id: "panel_id",
    patient_id: "patient_id",
    created_at: "created_at",
    test_name: "test_name",
    value: "value",
    unit: "unit",
  },
  reviewJobs: {},
}));

import { buildPatientContextForRules } from "../services/review-service.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

function primeSelectMocks(): void {
  selectMock.mockReset();
  diagnosesSelect.mockReset();
  medicationsSelect.mockReset();
  allergiesSelect.mockReset();
  labsSelect.mockReset();
  overridesSelect.mockReset();
  patientFindFirst.mockReset();

  diagnosesSelect.mockResolvedValue([]);
  medicationsSelect.mockResolvedValue([]);
  allergiesSelect.mockResolvedValue([]);
  labsSelect.mockResolvedValue([]);
  // Default: no overrides. Age enrichment tests don't exercise the
  // allergy-override suppression branch (#233), but the 5th select call
  // still fires inside the Promise.all so it must resolve to something
  // array-shaped to avoid a shape error in the consuming code.
  overridesSelect.mockResolvedValue([]);

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
    }))
    // 5th: allergy_overrides left-joined with clinical_flags (#233).
    .mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({ where: () => overridesSelect() }),
      }),
    }));
}

const eventAt = "2026-04-16T12:00:00.000Z";
const stubEvent: ClinicalEvent = {
  id: "evt-age-1",
  type: "vital.created",
  patient_id: "p-age-1",
  timestamp: eventAt,
  data: { chief_complaint: "fever" },
};

describe("buildPatientContextForRules — age_years enrichment (#236)", () => {
  beforeEach(() => {
    primeSelectMocks();
  });

  it("computes age_years from patient DOB relative to event timestamp", async () => {
    patientFindFirst.mockResolvedValue({
      id: "p-age-1",
      date_of_birth: "1956-04-16", // exactly 70 years before event
    });

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);

    expect(ctx.age_years).not.toBeNull();
    expect(ctx.age_years).toBeGreaterThanOrEqual(69.9);
    expect(ctx.age_years).toBeLessThanOrEqual(70.1);
  });

  it("computes pediatric age correctly", async () => {
    patientFindFirst.mockResolvedValue({
      id: "p-age-1",
      date_of_birth: "2016-04-16", // 10 years old at event
    });

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);

    expect(ctx.age_years).toBeGreaterThanOrEqual(9.9);
    expect(ctx.age_years).toBeLessThanOrEqual(10.1);
  });

  it("returns null age_years when patient has no date_of_birth", async () => {
    patientFindFirst.mockResolvedValue({
      id: "p-age-1",
      date_of_birth: null,
    });

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);
    expect(ctx.age_years).toBeNull();
  });

  it("returns null age_years when patient row is not found", async () => {
    patientFindFirst.mockResolvedValue(undefined);

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);
    expect(ctx.age_years).toBeNull();
  });

  it("returns null age_years when DOB is unparseable", async () => {
    patientFindFirst.mockResolvedValue({
      id: "p-age-1",
      date_of_birth: "not-a-date",
    });

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);
    expect(ctx.age_years).toBeNull();
  });

  it("returns null age_years when the query throws (defensive)", async () => {
    patientFindFirst.mockRejectedValue(new Error("db boom"));

    const ctx = await buildPatientContextForRules("p-age-1", stubEvent);
    expect(ctx.age_years).toBeNull();
  });

  it("anchors age computation to event timestamp, not wall clock", async () => {
    patientFindFirst.mockResolvedValue({
      id: "p-age-1",
      date_of_birth: "1990-01-01",
    });

    // Event 10 years in the past — patient should be ~26, not their
    // current-day age of ~36. Guards against TOCTOU drift.
    const pastEvent: ClinicalEvent = {
      ...stubEvent,
      timestamp: "2016-01-01T00:00:00.000Z",
    };

    const ctx = await buildPatientContextForRules("p-age-1", pastEvent);
    expect(ctx.age_years).toBeGreaterThanOrEqual(25.9);
    expect(ctx.age_years).toBeLessThanOrEqual(26.1);
  });
});
