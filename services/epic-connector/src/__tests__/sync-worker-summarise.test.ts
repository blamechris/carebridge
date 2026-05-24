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
import {
  summarise,
  SUMMARISE_SKIPPED_DETAIL_CAP,
} from "../workers/sync-worker.js";

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

  it("empty results → all zeros, empty skippedDetail, zero truncation counter", () => {
    const out = summarise([]);
    expect(out).toEqual({
      imported: 0,
      updated: 0,
      conflicts: 0,
      errors: 0,
      skipped: 0,
      skippedDetail: [],
      skippedDetailTruncated: 0,
    });
  });

  // ── #1120: cap skippedDetail to bound BullMQ payload size ────────
  // The full skipped set still lands on epic_sync_state via
  // markOk/markFailed, so operators have a recovery path via the DB
  // for the long tail. The cap protects the Redis-persisted job
  // result from bloat as fan-out widens (e.g., multi-status
  // MedicationRequest under #1114).

  it("exposes SUMMARISE_SKIPPED_DETAIL_CAP for callers that need the cap value", () => {
    expect(typeof SUMMARISE_SKIPPED_DETAIL_CAP).toBe("number");
    expect(SUMMARISE_SKIPPED_DETAIL_CAP).toBeGreaterThanOrEqual(50);
  });

  it("skippedDetail count == skipped count when under the cap; truncation counter stays at 0 (#1120)", () => {
    const skips = Array.from({ length: 5 }, (_, i) => ({
      resource_type: "Observation" as const,
      filter: { category: `cat-${i}` },
      reason: "unauthorized" as const,
    }));
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 0,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: skips,
      },
    ]);
    expect(out.skippedDetail).toHaveLength(5);
    expect(out.skipped).toBe(5);
    expect(out.skippedDetailTruncated).toBe(0);
  });

  it("caps skippedDetail at SUMMARISE_SKIPPED_DETAIL_CAP and reports the truncated count (#1120)", () => {
    const total = SUMMARISE_SKIPPED_DETAIL_CAP + 17;
    const skips = Array.from({ length: total }, (_, i) => ({
      resource_type: "Observation" as const,
      filter: { category: `cat-${i}` },
      reason: "unauthorized" as const,
    }));
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 0,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: skips,
      },
    ]);
    expect(out.skipped).toBe(total); // count remains the true total
    expect(out.skippedDetail).toHaveLength(SUMMARISE_SKIPPED_DETAIL_CAP);
    expect(out.skippedDetailTruncated).toBe(17);
    // Cap preserves the FIRST N entries (deterministic order, not random sample)
    expect(out.skippedDetail[0]).toEqual(skips[0]);
    expect(out.skippedDetail[SUMMARISE_SKIPPED_DETAIL_CAP - 1]).toEqual(
      skips[SUMMARISE_SKIPPED_DETAIL_CAP - 1],
    );
  });

  it("cap applies across multiple SyncResult entries (truncation kicks in mid-input) (#1120)", () => {
    // Split the skips across two results so the cap triggers
    // partway through the second. Verifies the reducer respects
    // the cap across iteration boundaries, not just per-result.
    const halfPlus = SUMMARISE_SKIPPED_DETAIL_CAP - 10;
    const overflow = 25;
    const firstSkips = Array.from({ length: halfPlus }, (_, i) => ({
      resource_type: "Observation" as const,
      filter: { category: `first-${i}` },
      reason: "unauthorized" as const,
    }));
    const secondSkips = Array.from({ length: overflow }, (_, i) => ({
      resource_type: "MedicationRequest" as const,
      filter: { status: `s-${i}` },
      reason: "unauthorized" as const,
    }));
    const out = summarise([
      {
        patient_id: "p1",
        resource_type: "Observation",
        imported: 0,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: firstSkips,
      },
      {
        patient_id: "p1",
        resource_type: "MedicationRequest",
        imported: 0,
        updated: 0,
        conflicts: 0,
        errors: [],
        skipped: secondSkips,
      },
    ]);
    expect(out.skipped).toBe(halfPlus + overflow);
    expect(out.skippedDetail).toHaveLength(SUMMARISE_SKIPPED_DETAIL_CAP);
    expect(out.skippedDetailTruncated).toBe(
      halfPlus + overflow - SUMMARISE_SKIPPED_DETAIL_CAP,
    );
  });
});
