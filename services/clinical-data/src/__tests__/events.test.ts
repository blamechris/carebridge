import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ── Mock BullMQ ─────────────────────────────────────────────────
const addMock = vi.fn().mockResolvedValue(undefined);
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
}));

// ── Mock DB ─────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock }),
  failedClinicalEvents: { id: "id" },
}));

// ── Import after mocks ──────────────────────────────────────────
const { emitClinicalEvent } = await import("../events.js");

const sampleEvent: ClinicalEvent = {
  id: "evt-1",
  type: "medication.created",
  patient_id: "patient-1",
  timestamp: "2026-04-12T00:00:00.000Z",
  data: { resourceId: "med-1", name: "Aspirin", status: "active" },
};

describe("emitClinicalEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds event to BullMQ queue on success", async () => {
    await emitClinicalEvent(sampleEvent);

    expect(addMock).toHaveBeenCalledWith(sampleEvent.type, sampleEvent);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("falls back to DB outbox when queue fails", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis connection refused"));

    await emitClinicalEvent(sampleEvent);

    expect(insertMock).toHaveBeenCalled();
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "medication.created",
        patient_id: "patient-1",
        event_payload: sampleEvent,
        error_message: "Redis connection refused",
        status: "pending",
        retry_count: 0,
      }),
    );
  });

  it("logs critical error when both queue and DB fallback fail", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis down"));
    insertValuesMock.mockRejectedValueOnce(new Error("DB down"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await emitClinicalEvent(sampleEvent);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CRITICAL]"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("medication.created"),
    );
    consoleSpy.mockRestore();
  });

  it("does not throw when queue fails — caller mutation succeeds", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis down"));

    await expect(emitClinicalEvent(sampleEvent)).resolves.toBeUndefined();
  });

  it("does not throw when both queue and DB fail — caller mutation succeeds", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis down"));
    insertValuesMock.mockRejectedValueOnce(new Error("DB down"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(emitClinicalEvent(sampleEvent)).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("handles non-Error queue failures gracefully", async () => {
    addMock.mockRejectedValueOnce("string error");

    await emitClinicalEvent(sampleEvent);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error_message: "string error",
      }),
    );
  });
});
