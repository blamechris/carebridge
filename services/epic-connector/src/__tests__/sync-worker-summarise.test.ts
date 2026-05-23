/**
 * Unit tests for the BullMQ sync worker's summarise() helper (#1107).
 *
 * summarise() rolls up the per-resource-type SyncResult[] into the
 * single object that gets returned as the BullMQ job result and shows
 * up in `job.returnvalue` for dashboards and ops tooling. PR #1106
 * added `SyncResult.skipped` for sub-resource scopes Epic refused —
 * this test suite enforces that skipped flows into the job-result
 * rollup so operators monitoring BullMQ see the auth-scope signal
 * without cross-referencing the epic_sync_state DB column.
 */
import { describe, it, expect } from "vitest";
import { summarise } from "../workers/sync-worker.js";

describe("summarise() (#1107)", () => {
  it("rolls up imported/updated/conflicts/errors as before", () => {
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 5,
        updated: 1,
        conflicts: 0,
        errors: [],
        skipped: [],
      },
      {
        patient_id: "p1",
        resource_type: "Condition",
        imported: 2,
        updated: 0,
        conflicts: 1,
        errors: ["boom"],
        skipped: [],
      },
    ]);
    expect(out).toMatchObject({
      imported: 7,
      updated: 1,
      conflicts: 1,
      errors: 1,
    });
  });

  it("includes skipped count rolled up across resource types", () => {
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 87,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: [
          {
            resource_type: "Observation",
            filter: { category: "vital-signs" },
            reason: "unauthorized",
          },
        ],
      },
      {
        patient_id: "p1",
        resource_type: "MedicationRequest",
        imported: 0,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: [
          {
            resource_type: "MedicationRequest",
            filter: { status: "active" },
            reason: "unauthorized",
          },
        ],
      },
      {
        patient_id: "p1",
        resource_type: "Condition",
        imported: 3,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: [],
      },
    ]);

    expect(out.skipped).toBe(2);
  });

  it("includes the full skipped detail list for dashboards needing structured drill-down", () => {
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 87,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: [
          {
            resource_type: "Observation",
            filter: { category: "vital-signs" },
            reason: "unauthorized",
          },
        ],
      },
    ]);

    expect(out.skippedDetail).toEqual([
      {
        resource_type: "Observation",
        filter: { category: "vital-signs" },
        reason: "unauthorized",
      },
    ]);
  });

  it("skipped=0 + skippedDetail=[] when nothing was soft-skipped", () => {
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Condition",
        imported: 5,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: [],
      },
    ]);
    expect(out.skipped).toBe(0);
    expect(out.skippedDetail).toEqual([]);
  });

  it("empty results → all zeros, empty skippedDetail", () => {
    const out = summarise([]);
    expect(out).toEqual({
      imported: 0,
      updated: 0,
      conflicts: 0,
      errors: 0,
      skipped: 0,
      skippedDetail: [],
    });
  });
});
