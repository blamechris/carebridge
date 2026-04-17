import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../src/index.js";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function parseLastLog(): Record<string, unknown> {
    const call = logSpy.mock.calls.at(-1) ?? errorSpy.mock.calls.at(-1);
    return JSON.parse(call![0] as string) as Record<string, unknown>;
  }

  function parseLastError(): Record<string, unknown> {
    const call = errorSpy.mock.calls.at(-1);
    return JSON.parse(call![0] as string) as Record<string, unknown>;
  }

  it("emits structured JSON with base fields", () => {
    const logger = createLogger("test-service");
    logger.info("hello");

    const entry = parseLastLog();
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("test-service");
    expect(entry.msg).toBe("hello");
    expect(entry.timestamp).toBeDefined();
  });

  it("includes metadata in log output", () => {
    const logger = createLogger("test-service");
    logger.info("with-meta", { requestId: "abc-123", userId: "u1" });

    const entry = parseLastLog();
    expect(entry.requestId).toBe("abc-123");
    expect(entry.userId).toBe("u1");
  });

  it("routes warn and error to stderr", () => {
    const logger = createLogger("test-service");

    logger.warn("warning");
    expect(errorSpy).toHaveBeenCalledTimes(1);

    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  describe("base field collision protection", () => {
    it("metadata cannot override 'level'", () => {
      const logger = createLogger("test-service");
      logger.info("test", { level: "error" });

      const entry = parseLastLog();
      expect(entry.level).toBe("info");
    });

    it("metadata cannot override 'service'", () => {
      const logger = createLogger("test-service");
      logger.info("test", { service: "evil-service" });

      const entry = parseLastLog();
      expect(entry.service).toBe("test-service");
    });

    it("metadata cannot override 'msg'", () => {
      const logger = createLogger("test-service");
      logger.info("real message", { msg: "fake message" });

      const entry = parseLastLog();
      expect(entry.msg).toBe("real message");
    });

    it("metadata cannot override 'timestamp'", () => {
      const logger = createLogger("test-service");
      logger.info("test", { timestamp: "1999-01-01T00:00:00.000Z" });

      const entry = parseLastLog();
      expect(entry.timestamp).not.toBe("1999-01-01T00:00:00.000Z");
    });
  });
});
