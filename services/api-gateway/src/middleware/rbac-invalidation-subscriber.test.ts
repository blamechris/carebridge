import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake ioredis client — captures .subscribe() + .on("message") so we can
// simulate PUBSUB deliveries without a real Redis.
const mocks = vi.hoisted(() => {
  const listeners: Array<(channel: string, message: string) => void> = [];
  const onHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const instance = {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "message") {
        listeners.push(handler as (channel: string, message: string) => void);
      }
      (onHandlers[event] ??= []).push(handler);
    },
    subscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  };
  return {
    instance,
    listeners,
    onHandlers,
    RedisCtor: vi.fn(() => instance),
  };
});

vi.mock("ioredis", () => ({
  default: mocks.RedisCtor,
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({ host: "localhost", port: 6379 }),
}));

const rbacMocks = vi.hoisted(() => ({
  applyInvalidationMessage: vi.fn(() => undefined),
}));

vi.mock("./rbac.js", () => ({
  CARE_TEAM_INVALIDATE_CHANNEL: "rbac:care_team:invalidate",
  applyInvalidationMessage: rbacMocks.applyInvalidationMessage,
}));

import { startCareTeamInvalidationSubscriber } from "./rbac-invalidation-subscriber.js";

describe("startCareTeamInvalidationSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.length = 0;
    for (const k of Object.keys(mocks.onHandlers)) delete mocks.onHandlers[k];
  });

  it("subscribes to the care-team invalidation channel", async () => {
    await startCareTeamInvalidationSubscriber();
    expect(mocks.instance.subscribe).toHaveBeenCalledWith(
      "rbac:care_team:invalidate",
    );
  });

  it("forwards received messages to applyInvalidationMessage", async () => {
    await startCareTeamInvalidationSubscriber();

    expect(mocks.listeners.length).toBeGreaterThan(0);
    mocks.listeners[0]!("rbac:care_team:invalidate", "user-A:patient-1");
    expect(rbacMocks.applyInvalidationMessage).toHaveBeenCalledWith(
      "user-A:patient-1",
    );
  });

  it("ignores messages on other channels", async () => {
    await startCareTeamInvalidationSubscriber();
    mocks.listeners[0]!("some-other-channel", "user-A:patient-1");
    expect(rbacMocks.applyInvalidationMessage).not.toHaveBeenCalled();
  });

  it("logs but does not throw when applyInvalidationMessage throws", async () => {
    const warn = vi.fn();
    rbacMocks.applyInvalidationMessage.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await startCareTeamInvalidationSubscriber({ warn });
    expect(() =>
      mocks.listeners[0]!("rbac:care_team:invalidate", "user-A:patient-1"),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("exposes quit() that closes the underlying client", async () => {
    const handle = await startCareTeamInvalidationSubscriber();
    await handle.quit();
    expect(mocks.instance.quit).toHaveBeenCalled();
  });

  it("swallows errors thrown by quit()", async () => {
    mocks.instance.quit.mockRejectedValueOnce(new Error("already closed"));
    const handle = await startCareTeamInvalidationSubscriber();
    await expect(handle.quit()).resolves.toBeUndefined();
  });
});
