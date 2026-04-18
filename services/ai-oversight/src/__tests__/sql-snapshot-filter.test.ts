import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Verify that buildPatientContextForRules and buildPatientContext push
 * snapshot-time predicates into the SQL WHERE clauses (#514) rather than
 * fetching the full patient history and filtering in memory.
 *
 * Strategy: capture the arguments passed to each Drizzle `.where()` call
 * and assert they include the expected column + operator predicates. This
 * is a structural test — it doesn't need a real DB, just confirms the
 * queries are shaped correctly.
 */

// ─── Captured where-clause arguments ───────────────────────────────
const diagnosesWhereSpy = vi.fn();
const medicationsWhereSpy = vi.fn();
const allergiesWhereSpy = vi.fn();
const labsWhereSpy = vi.fn();

const selectMock = vi.fn();

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ select: selectMock }),
  diagnoses: {
    patient_id: "diagnoses.patient_id",
    status: "diagnoses.status",
    onset_date: "diagnoses.onset_date",
    resolved_date: "diagnoses.resolved_date",
  },
  medications: {
    patient_id: "medications.patient_id",
    status: "medications.status",
    started_at: "medications.started_at",
    ended_at: "medications.ended_at",
  },
  allergies: {
    patient_id: "allergies.patient_id",
    created_at: "allergies.created_at",
    verification_status: "allergies.verification_status",
  },
  patients: {},
  labPanels: { id: "lab_panels.id", patient_id: "lab_panels.patient_id" },
  labResults: {
    panel_id: "lab_results.panel_id",
    patient_id: "lab_results.patient_id",
    created_at: "lab_results.created_at",
    test_name: "lab_results.test_name",
    value: "lab_results.value",
  },
  reviewJobs: {},
}));

import { buildPatientContextForRules } from "../services/review-service.js";
import type { ClinicalEvent } from "@carebridge/shared-types";

const eventAt = "2026-04-16T12:00:00.000Z";
const stubEvent: ClinicalEvent = {
  id: "evt-sql-1",
  type: "vital.created",
  patient_id: "p-sql-1",
  timestamp: eventAt,
  data: { chief_complaint: "fever" },
};

function primeSelectMocks(): void {
  selectMock.mockReset();
  diagnosesWhereSpy.mockReset();
  medicationsWhereSpy.mockReset();
  allergiesWhereSpy.mockReset();
  labsWhereSpy.mockReset();

  selectMock
    .mockImplementationOnce(() => ({
      from: () => ({
        where: (...args: unknown[]) => {
          diagnosesWhereSpy(...args);
          return Promise.resolve([]);
        },
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        where: (...args: unknown[]) => {
          medicationsWhereSpy(...args);
          return Promise.resolve([]);
        },
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        where: (...args: unknown[]) => {
          allergiesWhereSpy(...args);
          return Promise.resolve([]);
        },
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        innerJoin: () => ({
          where: (...args: unknown[]) => {
            labsWhereSpy(...args);
            return { orderBy: () => Promise.resolve([]) };
          },
        }),
      }),
    }));
}

describe("SQL snapshot filter predicates (#514)", () => {
  beforeEach(() => {
    primeSelectMocks();
  });

  it("passes timestamp-based predicates in the diagnoses WHERE clause", async () => {
    await buildPatientContextForRules("p-sql-1", stubEvent);

    expect(diagnosesWhereSpy).toHaveBeenCalledOnce();
    // The where clause is wrapped in and(...) which produces a single
    // Drizzle SQL object. Serialize to string to inspect.
    const whereArg = diagnosesWhereSpy.mock.calls[0]![0];
    const serialized = JSON.stringify(whereArg);

    // Should reference onset_date and resolved_date columns
    expect(serialized).toContain("onset_date");
    expect(serialized).toContain("resolved_date");
    // Should reference entered_in_error for the status != check
    expect(serialized).toContain("entered_in_error");
    // Should reference the event timestamp
    expect(serialized).toContain(eventAt);
  });

  it("passes timestamp-based predicates in the medications WHERE clause", async () => {
    await buildPatientContextForRules("p-sql-1", stubEvent);

    expect(medicationsWhereSpy).toHaveBeenCalledOnce();
    const whereArg = medicationsWhereSpy.mock.calls[0]![0];
    const serialized = JSON.stringify(whereArg);

    // Should reference started_at and ended_at columns
    expect(serialized).toContain("started_at");
    expect(serialized).toContain("ended_at");
    // Should reference entered_in_error for the status != check
    expect(serialized).toContain("entered_in_error");
    // Should reference the event timestamp
    expect(serialized).toContain(eventAt);
  });

  it("passes timestamp and retraction predicates in the allergies WHERE clause", async () => {
    await buildPatientContextForRules("p-sql-1", stubEvent);

    expect(allergiesWhereSpy).toHaveBeenCalledOnce();
    const whereArg = allergiesWhereSpy.mock.calls[0]![0];
    const serialized = JSON.stringify(whereArg);

    // Should reference created_at column with the event timestamp
    expect(serialized).toContain("created_at");
    expect(serialized).toContain(eventAt);
    // Should exclude entered_in_error and refuted
    expect(serialized).toContain("entered_in_error");
    expect(serialized).toContain("refuted");
  });

  it("passes event-time upper-bound predicate in the labs WHERE clause", async () => {
    await buildPatientContextForRules("p-sql-1", stubEvent);

    expect(labsWhereSpy).toHaveBeenCalledOnce();
    const whereArg = labsWhereSpy.mock.calls[0]![0];
    const serialized = JSON.stringify(whereArg);

    // Should reference created_at with the event timestamp as upper bound
    expect(serialized).toContain("created_at");
    expect(serialized).toContain(eventAt);
  });
});
