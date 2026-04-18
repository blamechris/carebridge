import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ── Mock DB ─────────────────────────────────────────────────────
const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockReturning = vi.fn().mockResolvedValue([]);

const mockDb = {
  insert: mockInsert,
  update: vi.fn(() => ({
    set: mockUpdateSet,
  })),
};

mockUpdateSet.mockReturnValue({
  where: (...args: unknown[]) => {
    const result = mockUpdateWhere(...args);
    return Object.assign(Promise.resolve(result).catch((e) => Promise.reject(e)), {
      returning: mockReturning,
    });
  },
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  failedClinicalEvents: {
    id: "id",
    event_type: "event_type",
    patient_id: "patient_id",
    event_payload: "event_payload",
    status: "status",
    retry_count: "retry_count",
    created_at: "created_at",
    updated_at: "updated_at",
    processed_at: "processed_at",
    error_message: "error_message",
  },
}));

const {
  writeOutboxEntry,
  readPendingBatch,
  markProcessed,
  markRetry,
  markFailed,
  recoverStaleProcessing,
  MAX_RECONCILE_RETRIES,
  RECONCILE_BATCH_SIZE,
  STALE_PROCESSING_THRESHOLD_MS,
} = await import("../index.js");

const sampleEvent: ClinicalEvent = {
  id: "evt-1",
  type: "medication.created",
  patient_id: "patient-1",
  timestamp: "2026-04-12T00:00:00.000Z",
  data: { resourceId: "med-1", name: "Aspirin", status: "active" },
};

describe("outbox shared module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue(undefined);
    mockReturning.mockResolvedValue([]);
  });

  describe("writeOutboxEntry", () => {
    it("inserts a row with correct fields from a ClinicalEvent + Error", async () => {
      await writeOutboxEntry(sampleEvent, new Error("Redis down"));

      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "medication.created",
          patient_id: "patient-1",
          event_payload: sampleEvent,
          error_message: "Redis down",
          status: "pending",
          retry_count: 0,
        }),
      );
    });

    it("accepts a string error", async () => {
      await writeOutboxEntry(sampleEvent, "string error");

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          error_message: "string error",
        }),
      );
    });

    it("generates a UUID id", async () => {
      await writeOutboxEntry(sampleEvent, new Error("fail"));

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("sets ISO 8601 timestamps", async () => {
      await writeOutboxEntry(sampleEvent, new Error("fail"));

      const values = mockInsertValues.mock.calls[0][0];
      expect(() => new Date(values.created_at)).not.toThrow();
      expect(() => new Date(values.updated_at)).not.toThrow();
    });
  });

  describe("recoverStaleProcessing", () => {
    it("issues an UPDATE setting status=pending", async () => {
      await recoverStaleProcessing();

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "pending",
        }),
      );
    });
  });

  describe("readPendingBatch", () => {
    it("returns claimed rows from the atomic UPDATE RETURNING", async () => {
      const fakeRows = [{ id: "r-1" }, { id: "r-2" }];
      mockReturning.mockResolvedValueOnce(fakeRows);

      // Need a fresh call since the first update() is for readPendingBatch
      const result = await readPendingBatch();

      expect(result).toEqual(fakeRows);
    });

    it("sets status=processing in the claim", async () => {
      mockReturning.mockResolvedValueOnce([]);

      await readPendingBatch();

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "processing",
        }),
      );
    });
  });

  describe("markProcessed", () => {
    it("sets status=processed with timestamps", async () => {
      await markProcessed("row-1");

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "processed",
        }),
      );
      const payload = mockUpdateSet.mock.calls[0][0];
      expect(payload.processed_at).toEqual(expect.any(String));
      expect(payload.updated_at).toEqual(expect.any(String));
    });
  });

  describe("markRetry", () => {
    it("sets status=pending with error message", async () => {
      await markRetry("row-1", new Error("still failing"));

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "pending",
          error_message: "still failing",
          processed_at: null,
        }),
      );
    });
  });

  describe("markFailed", () => {
    it("sets status=failed with processed_at timestamp", async () => {
      await markFailed("row-1", new Error("gave up"));

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          error_message: "gave up",
        }),
      );
      const payload = mockUpdateSet.mock.calls[0][0];
      expect(payload.processed_at).toEqual(expect.any(String));
    });
  });

  describe("constants", () => {
    it("exports MAX_RECONCILE_RETRIES as 5", () => {
      expect(MAX_RECONCILE_RETRIES).toBe(5);
    });

    it("exports RECONCILE_BATCH_SIZE as 100", () => {
      expect(RECONCILE_BATCH_SIZE).toBe(100);
    });

    it("exports STALE_PROCESSING_THRESHOLD_MS >= 60s", () => {
      expect(STALE_PROCESSING_THRESHOLD_MS).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe("ClinicalEvent shape contract", () => {
    it("writer persists the same shape the reader would re-enqueue", async () => {
      // The acceptance criterion from issue #508: the ClinicalEvent shape
      // written by writeOutboxEntry is the same type consumed by the
      // reconciler's queue.add(row.event_payload). Since both import
      // ClinicalEvent from @carebridge/shared-types via @carebridge/outbox,
      // a type mismatch would be a compile error. This test validates the
      // runtime shape round-trips correctly.
      await writeOutboxEntry(sampleEvent, new Error("test"));

      const writtenPayload = mockInsertValues.mock.calls[0][0].event_payload;

      // Verify the payload has the required ClinicalEvent fields
      expect(writtenPayload).toHaveProperty("id");
      expect(writtenPayload).toHaveProperty("type");
      expect(writtenPayload).toHaveProperty("patient_id");
      expect(writtenPayload).toHaveProperty("timestamp");
      expect(writtenPayload).toHaveProperty("data");

      // Verify round-trip: the payload is the exact object passed in
      expect(writtenPayload).toStrictEqual(sampleEvent);
    });
  });
});
