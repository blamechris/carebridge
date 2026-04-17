import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "./redis.js";

describe("getRedisConnection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_TLS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when no env vars are set", () => {
    const conn = getRedisConnection();
    expect(conn).toEqual({ host: "localhost", port: 6379 });
    expect(conn.password).toBeUndefined();
    expect(conn.tls).toBeUndefined();
  });

  it("reads host and port from env vars", () => {
    process.env.REDIS_HOST = "redis.example.com";
    process.env.REDIS_PORT = "6380";

    const conn = getRedisConnection();
    expect(conn.host).toBe("redis.example.com");
    expect(conn.port).toBe(6380);
  });

  it("includes password when REDIS_PASSWORD is set", () => {
    process.env.REDIS_PASSWORD = "s3cret";

    const conn = getRedisConnection();
    expect(conn.password).toBe("s3cret");
  });

  it("omits password when REDIS_PASSWORD is empty", () => {
    process.env.REDIS_PASSWORD = "";

    const conn = getRedisConnection();
    expect(conn.password).toBeUndefined();
  });

  it("includes tls when REDIS_TLS is 'true'", () => {
    process.env.REDIS_TLS = "true";

    const conn = getRedisConnection();
    expect(conn.tls).toEqual({});
  });

  it("omits tls when REDIS_TLS is not 'true'", () => {
    process.env.REDIS_TLS = "false";

    const conn = getRedisConnection();
    expect(conn.tls).toBeUndefined();
  });

  it("handles all env vars together", () => {
    process.env.REDIS_HOST = "prod.redis.io";
    process.env.REDIS_PORT = "6381";
    process.env.REDIS_PASSWORD = "p@ss";
    process.env.REDIS_TLS = "true";

    const conn = getRedisConnection();
    expect(conn).toEqual({
      host: "prod.redis.io",
      port: 6381,
      password: "p@ss",
      tls: {},
    });
  });
});

describe("CLINICAL_EVENTS_JOB_OPTIONS", () => {
  it("pins attempts=8 and base delay=2000 ms", () => {
    // Pin the exact invariants the retry-budget calculation depends on;
    // the ≥4-min floor below is a derived consequence. Changing either
    // value without touching these assertions is a silent behavior
    // change the floor assertion would miss.
    expect(CLINICAL_EVENTS_JOB_OPTIONS.attempts).toBe(8);
    expect(CLINICAL_EVENTS_JOB_OPTIONS.backoff.delay).toBe(2000);
  });

  it("provides at least 4 minutes of cumulative retry tolerance", () => {
    // 8 attempts with exponential backoff base 2000 ms:
    // 0 + 2 + 4 + 8 + 16 + 32 + 64 + 128 = 254 s ~= 4.2 min
    const base = CLINICAL_EVENTS_JOB_OPTIONS.backoff.delay;
    const attempts = CLINICAL_EVENTS_JOB_OPTIONS.attempts;
    let totalMs = 0;
    for (let i = 1; i < attempts; i++) totalMs += base * 2 ** (i - 1);
    expect(totalMs).toBeGreaterThanOrEqual(240_000);
  });

  it("uses exponential backoff", () => {
    expect(CLINICAL_EVENTS_JOB_OPTIONS.backoff.type).toBe("exponential");
  });

  it("keeps history bounded", () => {
    expect(CLINICAL_EVENTS_JOB_OPTIONS.removeOnComplete).toEqual({ age: 600, count: 1000 });
    expect(CLINICAL_EVENTS_JOB_OPTIONS.removeOnFail).toEqual({ count: 10000 });
  });
});
