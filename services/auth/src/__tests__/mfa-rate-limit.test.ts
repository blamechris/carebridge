import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkMFARateLimit,
  recordMFAAttempt,
  clearMFAAttempts,
  _resetAllAttempts,
  MFA_MAX_ATTEMPTS,
  MFA_WINDOW_MS,
} from "../mfa-rate-limit.js";

describe("MFA rate limiter", () => {
  beforeEach(() => {
    _resetAllAttempts();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first attempt", () => {
    const result = checkMFARateLimit("session-1");
    expect(result.allowed).toBe(true);
  });

  it("allows up to MAX_ATTEMPTS failed attempts", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      expect(checkMFARateLimit("session-1").allowed).toBe(true);
      recordMFAAttempt("session-1");
    }
  });

  it("blocks after MAX_ATTEMPTS failed attempts", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }
    const result = checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(MFA_WINDOW_MS);
  });

  it("returns correct retryAfterMs", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }

    // Advance 5 minutes
    vi.advanceTimersByTime(5 * 60 * 1000);

    const result = checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);
    // Should be roughly 10 minutes remaining
    expect(result.retryAfterMs).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(result.retryAfterMs).toBeGreaterThan(9 * 60 * 1000);
  });

  it("resets after the window expires", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }
    expect(checkMFARateLimit("session-1").allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(MFA_WINDOW_MS + 1);

    expect(checkMFARateLimit("session-1").allowed).toBe(true);
  });

  it("clearMFAAttempts resets the counter for a key", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }
    expect(checkMFARateLimit("session-1").allowed).toBe(false);

    clearMFAAttempts("session-1");
    expect(checkMFARateLimit("session-1").allowed).toBe(true);
  });

  it("tracks separate keys independently", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-a");
    }
    expect(checkMFARateLimit("session-a").allowed).toBe(false);
    expect(checkMFARateLimit("session-b").allowed).toBe(true);
  });

  it("recordMFAAttempt resets if window has expired", () => {
    recordMFAAttempt("session-1");
    recordMFAAttempt("session-1");

    // Advance past the window
    vi.advanceTimersByTime(MFA_WINDOW_MS + 1);

    // This should start a fresh window
    recordMFAAttempt("session-1");
    expect(checkMFARateLimit("session-1").allowed).toBe(true);

    // Should be able to do MAX_ATTEMPTS - 1 more (already recorded 1 above)
    for (let i = 1; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }
    expect(checkMFARateLimit("session-1").allowed).toBe(false);
  });

  it("reports retryAfterMs in minutes correctly for error messages", () => {
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
      recordMFAAttempt("session-1");
    }

    const result = checkMFARateLimit("session-1");
    expect(result.allowed).toBe(false);

    const retryMinutes = Math.ceil((result.retryAfterMs ?? 0) / 60_000);
    expect(retryMinutes).toBe(15);
  });
});
