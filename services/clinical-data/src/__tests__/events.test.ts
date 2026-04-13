import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ── Mock BullMQ ────────────────────────────────────────────────────
const addMock = vi.fn();
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: addMock,
  })),
}));

// ── Mock Redis ─────────────────────────────────────────────────────
vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
}));

// ── Mock DB ────────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
  }),
  failedClinicalEvents: { _: "failedClinicalEvents" },
}));

// ── Import after mocks ─────────────────────────────────────────────
const { emitClinicalEvent } = await import("../events.js");

const sampleEvent: ClinicalEvent = {
  id: "evt-001",
  type: "vital.created",
  patient_id: "patient-001",
  timestamp: "2026-04-12T10:00:00.000Z",
  data: { resourceId: "vital-001", vitalType: "heart_rate", value: 72 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitClinicalEvent", () => {
  it("adds the event to the BullMQ queue on success", async () => {
    addMock.mockResolvedValueOnce(undefined);

    await emitClinicalEvent(sampleEvent);

    expect(addMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledWith("vital.created", sampleEvent);
  });

  it("does not throw when BullMQ fails", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis connection refused"));

    // Must not throw — the caller's DB write should still succeed
    await expect(emitClinicalEvent(sampleEvent)).resolves.toBeUndefined();
  });

  it("persists the event to the fallback table when BullMQ fails", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis connection refused"));

    await emitClinicalEvent(sampleEvent);

    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledOnce();

    const insertedRow = insertValuesMock.mock.calls[0][0];
    expect(insertedRow).toMatchObject({
      event_type: "vital.created",
      event_payload: sampleEvent,
      error_message: "Redis connection refused",
      status: "pending",
      retry_count: 0,
    });
    expect(insertedRow.id).toBeDefined();
    expect(insertedRow.created_at).toBeDefined();
  });

  it("does not throw when both BullMQ and DB fallback fail", async () => {
    addMock.mockRejectedValueOnce(new Error("Redis connection refused"));
    insertValuesMock.mockRejectedValueOnce(new Error("DB connection lost"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Still must not throw
    await expect(emitClinicalEvent(sampleEvent)).resolves.toBeUndefined();

    // Should log the critical failure
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[CRITICAL] Failed to persist clinical event to fallback table",
      expect.objectContaining({
        event: sampleEvent,
        originalError: "Redis connection refused",
        dbError: "DB connection lost",
      }),
    );

    consoleErrorSpy.mockRestore();
  });

  it("logs event details when BullMQ fails", async () => {
    addMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await emitClinicalEvent(sampleEvent);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[EVENT_EMISSION_FAILED] Clinical event could not be queued",
      expect.objectContaining({
        eventId: "evt-001",
        eventType: "vital.created",
        patientId: "patient-001",
        error: "ECONNREFUSED",
      }),
    );

    consoleErrorSpy.mockRestore();
  });

  it("does not persist to fallback table when BullMQ succeeds", async () => {
    addMock.mockResolvedValueOnce(undefined);

    await emitClinicalEvent(sampleEvent);

    expect(insertMock).not.toHaveBeenCalled();
  });
});
