import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock ioredis with an in-memory store before importing the module
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

    async keys(pattern: string): Promise<string[]> {
      const prefix = pattern.replace("*", "");
      const now = Date.now();
      const result: string[] = [];
      for (const [k, v] of store) {
        if (k.startsWith(prefix) && now < v.expiresAt) {
          result.push(k);
        }
      }
      return result;
    }
  }

  return { default: MockRedis };
});

import {
  checkMFARateLimit,
  recordMFAAttempt,
  clearMFAAttempts,
  _resetAllAttempts,
  MFA_MAX_ATTEMPTS,
  MFA_WINDOW_MS,
} from "../mfa-rate-limit.js";

describe("MFA rate limiter", () => {
  beforeEach(async () => {
    store.clear();
    await _resetAllAttempts();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first attempt", async () => {
    const result = await checkMFARateLimit("session-1");
    expect(result.allowed).toBe(true);
  });

  it("allows up to MAX_ATTEMPTS failed attempts", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      expect((await checkMFARateLimit("session-1")).allowed).toBe(true);
      await recordMFAAttempt("session-1");
    }
  });

  it("blocks after MAX_ATTEMPTS failed attempts", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }
    const result = await checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(MFA_WINDOW_MS);
  });

  it("returns correct retryAfterMs", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    const result = await checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);
    // Should be roughly 10 minutes remaining
    expect(result.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(result.retryAfterMs).toBeGreaterThan(9 * 60 * 1000);
  });

  it("resets after the window expires", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }
    expect((await checkMFARateLimit("session-1")).allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(MFA_WINDOW_MS + 1);

    expect((await checkMFARateLimit("session-1")).allowed).toBe(true);
  });

  it("clearMFAAttempts resets the counter for a key", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }
    expect((await checkMFARateLimit("session-1")).allowed).toBe(false);

    await clearMFAAttempts("session-1");
    expect((await checkMFARateLimit("session-1")).allowed).toBe(true);
  });

  it("tracks separate keys independently", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-a");
    }
    expect((await checkMFARateLimit("session-a")).allowed).toBe(false);
    expect((await checkMFARateLimit("session-b")).allowed).toBe(true);
  });

  it("recordMFAAttempt resets if window has expired", async () => {
    await recordMFAAttempt("session-1");
    await recordMFAAttempt("session-1");

    // Advance past the window
    vi.advanceTimersByTime(MFA_WINDOW_MS + 1);

    // This should start a fresh window
    await recordMFAAttempt("session-1");
    expect((await checkMFARateLimit("session-1")).allowed).toBe(true);

    // Should be able to do MAX_ATTEMPTS - 1 more (already recorded 1 above)
    for (let i = 1; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }
    expect((await checkMFARateLimit("session-1")).allowed).toBe(false);
  });

  it("reports retryAfterMs in minutes correctly for error messages", async () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      await recordMFAAttempt("session-1");
    }

    const result = await checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);

    const retryMinutes = Math.ceil((result.retryAfterMs ?? 0) / 60_000);
    expect(retryMinutes).toBe(15);
  });
});
