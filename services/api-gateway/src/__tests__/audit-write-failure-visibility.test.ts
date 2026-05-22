/**
 * Tests for audit-write failure visibility (#996).
 *
 * Three call sites swallowed audit-insert failures with .catch(() => {})
 * or empty catch blocks, allowing PHI mutations to succeed without an
 * audit row — a HIPAA §164.312(b) integrity gap. This suite pins the
 * contract that each site now invokes a shared logger so the failure
 * lands in structured logs / alerts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { errorLog, mockLogger } = vi.hoisted(() => {
  const errorLog = vi.fn();
  return {
    errorLog,
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: errorLog,
    },
  };
});

vi.mock("@carebridge/logger", () => ({
  createLogger: () => mockLogger,
}));

import { recordAuditWriteFailure } from "../middleware/audit-failure.js";

describe("recordAuditWriteFailure (#996)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs at error level with stable msg 'audit_write_failed'", () => {
    recordAuditWriteFailure(new Error("connection refused"), {
      site: "rbac.emergency_access_used",
      userId: "user-1",
    });

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorLog.mock.calls[0];
    // Stable log msg so a log aggregator can alert on this exact string
    // without depending on the wording of any one call site.
    expect(msg).toBe("audit_write_failed");
    expect(meta).toEqual(
      expect.objectContaining({
        site: "rbac.emergency_access_used",
        userId: "user-1",
        error: expect.objectContaining({ message: "connection refused" }),
      }),
    );
  });

  it("handles non-Error throwables (caller passed a string, object, etc.)", () => {
    recordAuditWriteFailure("string thrown", { site: "test" });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [msg, meta] = errorLog.mock.calls[0];
    expect(msg).toBe("audit_write_failed");
    // Non-Error values still produce a structured error field with the
    // stringified value so log search doesn't lose the signal.
    expect(meta.error).toBeDefined();
  });

  it("never throws (audit failures must not crash the surrounding request path)", () => {
    expect(() =>
      recordAuditWriteFailure(new Error("x"), { site: "test" }),
    ).not.toThrow();
    expect(() =>
      recordAuditWriteFailure(null as unknown as Error, { site: "test" }),
    ).not.toThrow();
    expect(() =>
      recordAuditWriteFailure(undefined as unknown as Error, { site: "test" }),
    ).not.toThrow();
  });
});
