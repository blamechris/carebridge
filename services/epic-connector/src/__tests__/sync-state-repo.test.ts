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
