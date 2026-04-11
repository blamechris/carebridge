import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const { startCleanupWorkerMock } = vi.hoisted(() => ({
  startCleanupWorkerMock: vi.fn(async () => ({
    queue: { close: vi.fn() },
    worker: { close: vi.fn() },
  })),
}));

vi.mock("@carebridge/auth", () => ({
  startCleanupWorker: startCleanupWorkerMock,
}));

import { startBackgroundWorkers } from "../workers.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startBackgroundWorkers", () => {
  beforeEach(() => {
    startCleanupWorkerMock.mockClear();
  });

  it("starts the session cleanup worker", async () => {
    await startBackgroundWorkers();

    expect(startCleanupWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("returns the worker handles so callers can manage shutdown", async () => {
    const handles = await startBackgroundWorkers();

    expect(handles).toHaveProperty("sessionCleanup");
    expect(handles.sessionCleanup).toHaveProperty("queue");
    expect(handles.sessionCleanup).toHaveProperty("worker");
  });
});
