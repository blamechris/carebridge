import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @carebridge/db-schema so the middleware writes into an in-memory array.
// ---------------------------------------------------------------------------

const insertedRows: Record<string, unknown>[] = [];
const mockValues = vi.fn((row: Record<string, unknown>) => {
  insertedRows.push(row);
  return Promise.resolve();
});
const mockInsert = vi.fn(() => ({ values: mockValues }));

const mockDb = {
  insert: mockInsert,
};

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mockDb,
  auditLog: { __table: "audit_log" },
}));

import { auditMiddleware } from "../middleware/audit.js";
import type { FastifyReply, FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    url: "/trpc/patients.getById",
    method: "POST",
    ip: "10.0.0.1",
    body: { json: { patientId: "pat-1" } },
    log: { error: vi.fn() },
    user: {
      id: "user-1",
      email: "dr.smith@carebridge.dev",
      name: "Dr. Smith",
      role: "physician",
      is_active: true,
    },
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(statusCode: number): FastifyReply {
  return { statusCode } as unknown as FastifyReply;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit middleware — HTTP status / success indicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRows.length = 0;
  });

  it("records success=true and http_status_code=200 for 2xx responses", async () => {
    await auditMiddleware(makeRequest(), makeReply(200));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(200);
    expect(row.success).toBe(true);
    expect(row.error_message).toBeNull();
  });

  it("treats 201 Created as a successful response", async () => {
    await auditMiddleware(makeRequest(), makeReply(201));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(201);
    expect(row.success).toBe(true);
  });

  it("records success=false and 401 for UNAUTHORIZED responses", async () => {
    await auditMiddleware(makeRequest(), makeReply(401));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(401);
    expect(row.success).toBe(false);
    expect(row.error_message).toBe("Unauthorized");
  });

  it("records success=false and 403 for FORBIDDEN responses", async () => {
    await auditMiddleware(makeRequest(), makeReply(403));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(403);
    expect(row.success).toBe(false);
    expect(row.error_message).toBe("Forbidden");
  });

  it("records success=false and 404 for NOT_FOUND responses", async () => {
    await auditMiddleware(makeRequest(), makeReply(404));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(404);
    expect(row.success).toBe(false);
    expect(row.error_message).toBe("Not Found");
  });

  it("records success=false and 429 for rate-limited responses", async () => {
    await auditMiddleware(makeRequest(), makeReply(429));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(429);
    expect(row.success).toBe(false);
    expect(row.error_message).toBe("Too Many Requests");
  });

  it("records success=false and 500 for server errors", async () => {
    await auditMiddleware(makeRequest(), makeReply(500));

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.http_status_code).toBe(500);
    expect(row.success).toBe(false);
    expect(row.error_message).toBe("Internal Server Error");
  });

  it("skips audit logging for /health requests regardless of status", async () => {
    await auditMiddleware(
      makeRequest({ url: "/health", method: "GET", body: undefined }),
      makeReply(200),
    );

    expect(insertedRows).toHaveLength(0);
  });
});
