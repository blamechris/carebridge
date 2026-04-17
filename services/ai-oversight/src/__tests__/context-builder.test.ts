import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db-schema BEFORE importing the module under test.
//
// buildPatientContext issues eight parallel reads (patient, diagnoses,
// allergies, medications, vitals, lab panels, recent flags, care team)
// followed by a conditional lab-results read and an optional users
// lookup. We drive each one with its own sequenced mock so tests assert
// on filtering behavior (TOCTOU, retractions) without wiring a real DB.
const diagnosesSelect = vi.fn();
const allergiesSelect = vi.fn();
const medicationsSelect = vi.fn();
const vitalsSelect = vi.fn();
const labPanelsSelect = vi.fn();
const clinicalFlagsSelect = vi.fn();
const careTeamSelect = vi.fn();
const labResultsSelect = vi.fn();
const usersSelect = vi.fn();
const selectMock = vi.fn();

const patientFindFirst = vi.fn();

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    select: selectMock,
    query: {
      patients: { findFirst: patientFindFirst },
    },
  }),
  patients: {},
  diagnoses: { patient_id: "patient_id", status: "status" },
  medications: { patient_id: "patient_id", status: "status" },
  allergies: { patient_id: "patient_id" },
  vitals: { patient_id: "patient_id", recorded_at: "recorded_at" },
  labPanels: { id: "id", patient_id: "patient_id", collected_at: "collected_at" },
  labResults: { panel_id: "panel_id", created_at: "created_at" },
  clinicalFlags: { patient_id: "patient_id", created_at: "created_at" },
  careTeamMembers: { patient_id: "patient_id", is_active: "is_active" },
  users: { id: "id" },
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  sanitizeFreeText: (s: string) => s,
}));

vi.mock("@carebridge/medical-logic", () => ({
  calculateDelta: () => null,
}));

import { buildPatientContext } from "../workers/context-builder.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

const EVENT_AT = "2026-04-16T12:00:00.000Z";

const baseEvent: ClinicalEvent = {
  id: "evt-1",
  type: "vital.created",
  patient_id: "p-1",
  timestamp: EVENT_AT,
  data: { chief_complaint: "fever" },
};

describe("buildPatientContext — event-time snapshot (LLM path)", () => {
  beforeEach(() => {
    selectMock.mockReset();
    diagnosesSelect.mockReset();
    allergiesSelect.mockReset();
    medicationsSelect.mockReset();
    vitalsSelect.mockReset();
    labPanelsSelect.mockReset();
    clinicalFlagsSelect.mockReset();
    careTeamSelect.mockReset();
    labResultsSelect.mockReset();
    usersSelect.mockReset();
    patientFindFirst.mockReset();

    // Sensible defaults — tests override as needed.
    patientFindFirst.mockResolvedValue({
      id: "p-1",
      date_of_birth: "1970-01-01",
      biological_sex: "female",
      allergy_status: "has_allergies",
      name: "Test Patient",
    });
    diagnosesSelect.mockResolvedValue([]);
    allergiesSelect.mockResolvedValue([]);
    medicationsSelect.mockResolvedValue([]);
    vitalsSelect.mockResolvedValue([]);
    labPanelsSelect.mockResolvedValue([]);
    clinicalFlagsSelect.mockResolvedValue([]);
    careTeamSelect.mockResolvedValue([]);
    labResultsSelect.mockResolvedValue([]);
    usersSelect.mockResolvedValue([]);

    // The call ordering mirrors the Promise.all in buildPatientContext:
    //   1. diagnoses        (select → from → where)
    //   2. allergies        (select → from → where)
    //   3. medications      (select → from → where)
    //   4. vitals           (select → from → where → orderBy → limit)
    //   5. labPanels        (select → from → where → orderBy → limit)
    //   6. clinicalFlags    (select → from → where → orderBy → limit)
    //   7. careTeam         (select → from → where)
    // Then, only if lab panels returned rows:
    //   8. labResults       (select → from → where)
    // Then, only if care team is non-empty:
    //   9. users            (select → from → where)
    selectMock
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => diagnosesSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => allergiesSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => medicationsSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => vitalsSelect() }),
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => labPanelsSelect() }),
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => clinicalFlagsSelect() }),
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => careTeamSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => labResultsSelect() }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => usersSelect() }),
      }));
  });

  it("includes a medication that is discontinued AFTER the event timestamp (TOCTOU)", async () => {
    // Mirrors the load-bearing test from build-patient-context.test.ts —
    // the med was active when the event was emitted, then discontinued
    // before the LLM review ran. The LLM context MUST still see it so
    // its view aligns with the rule-path view.
    medicationsSelect.mockResolvedValue([
      {
        name: "Apixaban",
        status: "discontinued",
        started_at: "2026-04-01T00:00:00.000Z",
        ended_at: "2026-04-16T15:00:00.000Z", // 3h AFTER event
        created_at: "2026-04-01T00:00:00.000Z",
        dose_amount: "5",
        dose_unit: "mg",
        route: "PO",
        frequency: "BID",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.active_medications.map((m) => m.name)).toContain("Apixaban");
  });

  it("excludes a medication discontinued BEFORE the event timestamp", async () => {
    medicationsSelect.mockResolvedValue([
      {
        name: "Warfarin",
        status: "active", // stale status
        started_at: "2026-04-06T00:00:00.000Z",
        ended_at: "2026-04-15T00:00:00.000Z", // ended 1d before event
        created_at: "2026-04-06T00:00:00.000Z",
        dose_amount: "5",
        dose_unit: "mg",
        route: "PO",
        frequency: "Daily",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.active_medications.map((m) => m.name)).not.toContain("Warfarin");
  });

  it("excludes an allergy added after the event timestamp", async () => {
    allergiesSelect.mockResolvedValue([
      {
        allergen: "penicillin",
        verification_status: "confirmed",
        created_at: "2026-04-16T13:00:00.000Z", // 1h AFTER event
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.patient.allergies).toHaveLength(0);
  });

  it("excludes allergies with verification_status = entered_in_error or refuted", async () => {
    allergiesSelect.mockResolvedValue([
      {
        allergen: "penicillin",
        verification_status: "entered_in_error",
        created_at: "2026-04-01T00:00:00.000Z",
      },
      {
        allergen: "latex",
        verification_status: "refuted",
        created_at: "2026-04-01T00:00:00.000Z",
      },
      {
        allergen: "sulfa",
        verification_status: "confirmed",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    const allergens = ctx.patient.allergies.map((a) =>
      typeof a === "string" ? a : a.allergen,
    );
    expect(allergens).toEqual(["sulfa"]);
  });

  it("excludes a diagnosis resolved before the event timestamp", async () => {
    diagnosesSelect.mockResolvedValue([
      {
        description: "Strep throat (resolved)",
        icd10_code: "J02.0",
        status: "active", // stale status
        onset_date: "2026-04-01T00:00:00.000Z",
        resolved_date: "2026-04-10T00:00:00.000Z",
        created_at: "2026-04-01T00:00:00.000Z",
      },
      {
        description: "Breast cancer",
        icd10_code: "C50.9",
        status: "active",
        onset_date: "2025-01-01T00:00:00.000Z",
        resolved_date: null,
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.patient.active_diagnoses).not.toContain(
      "Strep throat (resolved)",
    );
    expect(ctx.patient.active_diagnoses).toContain("Breast cancer");
  });

  it("excludes lab results reported after the event timestamp", async () => {
    labPanelsSelect.mockResolvedValue([
      { id: "panel-1", collected_at: "2026-04-16T09:00:00.000Z" },
    ]);
    labResultsSelect.mockResolvedValue([
      {
        test_name: "ANC",
        value: 900,
        unit: "cells/uL",
        flag: null,
        panel_id: "panel-1",
        created_at: "2026-04-16T15:00:00.000Z", // AFTER event
      },
      {
        test_name: "WBC",
        value: 2.1,
        unit: "K/uL",
        flag: "low",
        panel_id: "panel-1",
        created_at: "2026-04-16T10:00:00.000Z", // BEFORE event
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.recent_labs).toBeDefined();
    expect(ctx.recent_labs?.map((l) => l.test_name)).toEqual(["WBC"]);
  });

  // ─── #513 — normalize ISO timestamp comparisons ────────────────────
  it("compares offset-form (-05:00) timestamps identically to equivalent Z-form", async () => {
    // The resolved_date is expressed with a UTC-5 offset; the event uses
    // Z-form. Lex compare mis-sorts them; Date.parse normalization treats
    // them as the same instant, so the diagnosis is correctly excluded.
    diagnosesSelect.mockResolvedValue([
      {
        description: "Flu (offset-form resolved_date)",
        icd10_code: "J10.1",
        status: "active",
        onset_date: "2026-04-01T00:00:00.000Z",
        resolved_date: "2026-04-16T07:00:00.000-05:00",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.patient.active_diagnoses).not.toContain(
      "Flu (offset-form resolved_date)",
    );
  });

  it("compares bare-date onset timestamps correctly against Z-form event", async () => {
    diagnosesSelect.mockResolvedValue([
      {
        description: "Hypertension (bare-date onset, still active)",
        icd10_code: "I10",
        status: "active",
        onset_date: "2025-01-15",
        resolved_date: null,
        created_at: "2025-01-15T00:00:00.000Z",
      },
      {
        description: "Bronchitis (bare-date resolved before event)",
        icd10_code: "J40",
        status: "active",
        onset_date: "2026-04-01",
        resolved_date: "2026-04-10",
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.patient.active_diagnoses).toContain(
      "Hypertension (bare-date onset, still active)",
    );
    expect(ctx.patient.active_diagnoses).not.toContain(
      "Bronchitis (bare-date resolved before event)",
    );
  });

  // ─── #632 — exclude entered_in_error medications ───────────────────
  it("excludes a medication with status=entered_in_error even when timestamps say active", async () => {
    medicationsSelect.mockResolvedValue([
      {
        name: "Methotrexate (charting mistake)",
        status: "entered_in_error",
        started_at: "2026-04-01T00:00:00.000Z",
        ended_at: null,
        created_at: "2026-04-01T00:00:00.000Z",
        dose_amount: "15",
        dose_unit: "mg",
        route: "PO",
        frequency: "Weekly",
      },
      {
        name: "Cisplatin",
        status: "active",
        started_at: "2026-04-01T00:00:00.000Z",
        ended_at: null,
        created_at: "2026-04-01T00:00:00.000Z",
        dose_amount: "75",
        dose_unit: "mg/m2",
        route: "IV",
        frequency: "Q3W",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    const medNames = ctx.active_medications.map((m) => m.name);
    expect(medNames).not.toContain("Methotrexate (charting mistake)");
    expect(medNames).toContain("Cisplatin");
  });

  it("excludes entered_in_error medication even when it has no ended_at (open-ended retraction)", async () => {
    medicationsSelect.mockResolvedValue([
      {
        name: "Warfarin (never actually ordered)",
        status: "entered_in_error",
        started_at: "2026-04-10T00:00:00.000Z",
        ended_at: null,
        created_at: "2026-04-10T00:00:00.000Z",
        dose_amount: "5",
        dose_unit: "mg",
        route: "PO",
        frequency: "Daily",
      },
    ]);

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.active_medications).toHaveLength(0);
  });

  // ─── #515 — exclude logical retractions ────────────────────────────
  it("excludes a diagnosis with status=entered_in_error even when timestamps say active", async () => {
    diagnosesSelect.mockResolvedValue([
      {
        description: "Myocardial infarction (charting mistake)",
        icd10_code: "I21.9",
        status: "entered_in_error",
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

    const ctx = await buildPatientContext("p-1", baseEvent);

    expect(ctx.patient.active_diagnoses).not.toContain(
      "Myocardial infarction (charting mistake)",
    );
    expect(ctx.patient.active_diagnoses).toContain(
      "Breast cancer (chronic, real)",
    );
  });
});
