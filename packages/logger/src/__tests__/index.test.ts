import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger } from "../index.js";

describe("createLogger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an object with debug, info, warn, error methods", () => {
    const logger = createLogger("test-service");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("sets the service field from the createLogger argument", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("my-service");
    logger.info("hello");

    const entry = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(entry.service).toBe("my-service");
  });

  describe("NDJSON output", () => {
    it("emits valid JSON on a single line", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.info("test message");

      expect(spy).toHaveBeenCalledOnce();
      const raw = spy.mock.calls[0]![0] as string;
      // Should not contain newlines (NDJSON = one JSON object per line)
      expect(raw).not.toContain("\n");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty("timestamp");
      expect(parsed).toHaveProperty("level", "info");
      expect(parsed).toHaveProperty("service", "svc");
      expect(parsed).toHaveProperty("msg", "test message");
    });

    it("includes an ISO 8601 timestamp", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.info("ts check");

      const entry = JSON.parse(spy.mock.calls[0]![0] as string);
      // ISO 8601 format check — Date constructor should accept it
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });
  });

  describe("log level routing", () => {
    it("routes debug to console.log", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.debug("dbg");

      expect(logSpy).toHaveBeenCalledOnce();
      expect(errorSpy).not.toHaveBeenCalled();
      const entry = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(entry.level).toBe("debug");
    });

    it("routes info to console.log", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.info("inf");

      expect(logSpy).toHaveBeenCalledOnce();
      expect(errorSpy).not.toHaveBeenCalled();
      const entry = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(entry.level).toBe("info");
    });

    it("routes warn to console.error", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.warn("wrn");

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(logSpy).not.toHaveBeenCalled();
      const entry = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(entry.level).toBe("warn");
    });

    it("routes error to console.error", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.error("err");

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(logSpy).not.toHaveBeenCalled();
      const entry = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(entry.level).toBe("error");
    });
  });

  describe("metadata merging", () => {
    it("spreads metadata fields into the log entry", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.info("with meta", { requestId: "abc-123", userId: "u-1" });

      const entry = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(entry.requestId).toBe("abc-123");
      expect(entry.userId).toBe("u-1");
      expect(entry.msg).toBe("with meta");
    });

    it("works without metadata", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("svc");
      logger.info("no meta");

      const entry = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(entry.msg).toBe("no meta");
      // Only base fields present
      expect(Object.keys(entry).sort()).toEqual(
        ["level", "msg", "service", "timestamp"].sort(),
      );
    });

    it("preserves base fields when metadata has extra keys", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger("audit-svc");
      logger.error("failure", { code: 500, detail: "timeout" });

      const entry = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(entry.service).toBe("audit-svc");
      expect(entry.level).toBe("error");
      expect(entry.msg).toBe("failure");
      expect(entry.code).toBe(500);
      expect(entry.detail).toBe("timeout");
    });
  });
});
