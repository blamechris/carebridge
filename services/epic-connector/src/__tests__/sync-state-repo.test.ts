/**
 * Tests for the epic_sync_state CRUD helpers (#391).
 *
 * Uses the shared mock-db builder so the chain assertions stay decoupled
 * from any drizzle method-order quirks. No real Postgres involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  epicSyncState: {
    patient_id: "patient_id",
    resource_type: "resource_type",
    status: "status",
    last_error_at: "last_error_at",
  },
}));

const {
  getSyncState,
  getAllSyncStatesForPatient,
  markRunning,
  markOk,
  markFailed,
  listRecentFailures,
} = await import("../sync/sync-state-repo.js");

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

describe("epic_sync_state repo (#391)", () => {
  it("getSyncState returns the first row or null", async () => {
    db.willSelect([
      {
        patient_id: PATIENT_ID,
        resource_type: "Observation",
        status: "ok",
        last_synced_at: "2026-05-20T00:00:00Z",
        last_fhir_lastupdated: "2026-05-19T23:00:00Z",
        resources_synced_count: 5,
        error_count: 0,
        last_error_message: null,
        last_error_at: null,
      },
    ]);
    const row = await getSyncState(PATIENT_ID, "Observation");
    expect(row?.status).toBe("ok");
    expect(row?.last_fhir_lastupdated).toBe("2026-05-19T23:00:00Z");
  });

  it("getSyncState returns null when no row exists", async () => {
    db.willSelect([]);
    const row = await getSyncState(PATIENT_ID, "Observation");
    expect(row).toBeNull();
  });

  it("getAllSyncStatesForPatient returns every row for the patient", async () => {
    db.willSelect([
      { patient_id: PATIENT_ID, resource_type: "Observation", status: "ok" },
      { patient_id: PATIENT_ID, resource_type: "Condition", status: "failed" },
    ]);
    const rows = await getAllSyncStatesForPatient(PATIENT_ID);
    expect(rows).toHaveLength(2);
  });

  it("markRunning upserts a row with status=running", async () => {
    db.willInsert();
    await markRunning(PATIENT_ID, "Observation");
    expect(db.insert).toHaveBeenCalledOnce();
    const call = db.insert.calls[0]!;
    expect(call.chain).toContain("values");
    expect(call.chain).toContain("onConflictDoUpdate");
    const values = call.chainArgs[0]![0] as Record<string, unknown>;
    expect(values.status).toBe("running");
  });

  it("markOk records the high watermark and increments the success counter", async () => {
    db.willInsert();
    await markOk({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      highWatermark: "2026-05-20T12:00:00Z",
      importedCount: 7,
    });
    expect(db.insert).toHaveBeenCalledOnce();
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(values.status).toBe("ok");
    expect(values.last_fhir_lastupdated).toBe("2026-05-20T12:00:00Z");
    expect(values.resources_synced_count).toBe(7);
    // #1097: defaults to empty array when caller doesn't pass `skipped`.
    expect(values.skipped_sub_resources).toEqual([]);
  });

  it("markOk persists the skipped sub-resources array when provided (#1097)", async () => {
    db.willInsert();
    await markOk({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      highWatermark: null,
      importedCount: 3,
      skipped: [
        { filter: { category: "vital-signs" }, reason: "unauthorized" },
      ],
    });
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(values.skipped_sub_resources).toEqual([
      { filter: { category: "vital-signs" }, reason: "unauthorized" },
    ]);
    // onConflictDoUpdate `set` also carries the latest skipped state so
    // re-runs replace stale entries instead of merging them.
    const setClause = db.insert.calls[0]!.chainArgs[1]![0] as { set: Record<string, unknown> };
    expect(setClause.set.skipped_sub_resources).toEqual([
      { filter: { category: "vital-signs" }, reason: "unauthorized" },
    ]);
  });

  it("markFailed truncates very long error messages to 1KiB", async () => {
    db.willInsert();
    const oversized = "x".repeat(2048);
    await markFailed({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      errorMessage: oversized,
    });
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect((values.last_error_message as string).length).toBe(1024);
    expect(values.status).toBe("failed");
    expect(values.error_count).toBe(1);
  });

  it("markFailed does NOT write skipped_sub_resources when nothing partial was collected (#1118 — preserves prior successful sync's skipped data)", async () => {
    db.willInsert();
    await markFailed({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      errorMessage: "ECONNREFUSED",
      // No skipped collected — most failure modes (network down, token
      // refresh fail, 500 on the first call). Repo must leave the
      // column untouched so a prior successful sync's recorded skips
      // aren't wiped to [] by every subsequent failed run.
    });
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(values).not.toHaveProperty("skipped_sub_resources");
    const setClause = db.insert.calls[0]!.chainArgs[1]![0] as { set: Record<string, unknown> };
    expect(setClause.set).not.toHaveProperty("skipped_sub_resources");
  });

  it("markFailed does NOT write skipped_sub_resources when caller passes an explicit empty array (#1118)", async () => {
    db.willInsert();
    await markFailed({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      errorMessage: "ECONNREFUSED",
      skipped: [],
    });
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(values).not.toHaveProperty("skipped_sub_resources");
    const setClause = db.insert.calls[0]!.chainArgs[1]![0] as { set: Record<string, unknown> };
    expect(setClause.set).not.toHaveProperty("skipped_sub_resources");
  });

  it("markFailed persists the partial soft-skipped array when provided (#1108)", async () => {
    db.willInsert();
    await markFailed({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      errorMessage: "ECONNREFUSED",
      skipped: [
        { filter: { category: "vital-signs" }, reason: "unauthorized" },
      ],
    });
    const values = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(values.skipped_sub_resources).toEqual([
      { filter: { category: "vital-signs" }, reason: "unauthorized" },
    ]);
    // onConflictDoUpdate `set` carries the latest skipped state so a
    // re-run replaces stale data instead of merging it.
    const setClause = db.insert.calls[0]!.chainArgs[1]![0] as { set: Record<string, unknown> };
    expect(setClause.set.skipped_sub_resources).toEqual([
      { filter: { category: "vital-signs" }, reason: "unauthorized" },
    ]);
    expect(setClause.set.status).toBe("failed");
  });

  it("listRecentFailures filters status=failed and orders by last_error_at desc", async () => {
    db.willSelect([
      { patient_id: PATIENT_ID, resource_type: "Observation", status: "failed" },
    ]);
    const rows = await listRecentFailures(10);
    expect(rows).toHaveLength(1);
    const call = db.select.calls[0]!;
    expect(call.chain).toContain("where");
    expect(call.chain).toContain("orderBy");
    expect(call.chain).toContain("limit");
  });
});
