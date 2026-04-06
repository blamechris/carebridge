import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRedisConnection } from "./redis.js";

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
