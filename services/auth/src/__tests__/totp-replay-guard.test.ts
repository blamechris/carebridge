import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory store to mock Redis
const store = new Map<string, { value: string; expiresAt: number }>();

vi.mock("ioredis", () => {
  class MockRedis {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }

    async set(key: string, value: string, _mode?: string, ttl?: number): Promise<"OK"> {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : Infinity;
      store.set(key, { value, expiresAt });
      return "OK";
    }

    async del(...keys: string[]): Promise<number> {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted++;
      }
      return deleted;
    }

    async exists(key: string): Promise<number> {
      const entry = store.get(key);
      if (!entry) return 0;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return 0;
      }
      return 1;
    }
  }

  return { default: MockRedis };
});

// Must mock @carebridge/redis-config before importing the module
vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({
    host: "localhost",
    port: 6379,
    password: undefined,
    tls: undefined,
  }),
}));

import { isTOTPCodeUsed, markTOTPCodeUsed } from "../totp-replay-guard.js";

describe("TOTP replay guard", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns false for an unused code", async () => {
    const used = await isTOTPCodeUsed("user-1", "123456");
    expect(used).toBe(false);
  });

  it("returns true after marking a code as used", async () => {
    await markTOTPCodeUsed("user-1", "654321");
    const used = await isTOTPCodeUsed("user-1", "654321");
    expect(used).toBe(true);
  });

  it("tracks codes per user independently", async () => {
    await markTOTPCodeUsed("user-a", "111111");

    expect(await isTOTPCodeUsed("user-a", "111111")).toBe(true);
    expect(await isTOTPCodeUsed("user-b", "111111")).toBe(false);
  });

  it("tracks different codes for the same user independently", async () => {
    await markTOTPCodeUsed("user-1", "111111");

    expect(await isTOTPCodeUsed("user-1", "111111")).toBe(true);
    expect(await isTOTPCodeUsed("user-1", "222222")).toBe(false);
  });
});
