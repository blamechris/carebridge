import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db-schema BEFORE importing the module under test.
const diagnosesSelect = vi.fn();
const medicationsSelect = vi.fn();
const allergiesSelect = vi.fn();
const labsSelect = vi.fn();

// The real module uses four parallel select() calls inside Promise.all.
// We return a different chain per call via mockImplementation sequencing.
const selectMock = vi
  .fn()
  // Call 1: diagnoses
  .mockImplementationOnce(() => ({
    from: () => ({ where: () => diagnosesSelect() }),
  }))
  // Call 2: medications
  .mockImplementationOnce(() => ({
    from: () => ({ where: () => medicationsSelect() }),
  }))
  // Call 3: allergies
  .mockImplementationOnce(() => ({
    from: () => ({ where: () => allergiesSelect() }),
  }))
  // Call 4: lab_results JOIN lab_panels
  .mockImplementationOnce(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          orderBy: () => labsSelect(),
        }),
      }),
    }),
  }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ select: selectMock }),
  diagnoses: {},
  medications: {},
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
    selectMock.mockClear();
    diagnosesSelect.mockClear();
    medicationsSelect.mockClear();
    allergiesSelect.mockClear();
    labsSelect.mockClear();

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
});
