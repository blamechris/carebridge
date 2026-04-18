import { describe, it, expect } from "vitest";
import type { User } from "@carebridge/shared-types";
import { handleAuthMe } from "../handlers/auth-me.js";

/**
 * Tests for the GET /auth/me endpoint behaviour.
 *
 * The endpoint is a thin Fastify route registered in server.ts that delegates
 * to `handleAuthMe` (see ../handlers/auth-me.ts). Importing the extracted
 * handler directly lets us exercise the full contract without bootstrapping
 * Fastify and all its plugins, while guaranteeing the test and the route
 * share the exact same code path.
 *
 *   - 401 when `request.user` is falsy
 *   - User profile payload when `request.user` is present
 */

interface MockReply {
  statusCode: number;
  body: unknown;
  code(c: number): MockReply;
  send(b: unknown): MockReply;
}

function createMockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    body: undefined,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    send(b: unknown) {
      reply.body = b;
      return reply;
    },
  };
  return reply;
}

describe("GET /auth/me handler", () => {
  it("returns 401 when request.user is not set", async () => {
    const reply = createMockReply();
    await handleAuthMe({ user: undefined }, reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Not authenticated" });
  });

  it("returns the user profile when authenticated", async () => {
    const user: User = {
      id: "u-1",
      email: "dr.smith@carebridge.dev",
      name: "Dr. Smith",
      role: "physician",
      specialty: "Hematology/Oncology",
      department: "Oncology",
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    };
    const reply = createMockReply();
    const result = await handleAuthMe({ user }, reply);
    expect(result).toEqual({
      id: "u-1",
      email: "dr.smith@carebridge.dev",
      name: "Dr. Smith",
      role: "physician",
      specialty: "Hematology/Oncology",
      department: "Oncology",
      patient_id: undefined,
    });
  });

  it("includes patient_id for patient-role users", async () => {
    const user: User = {
      id: "u-2",
      email: "patient@carebridge.dev",
      name: "Patient User",
      role: "patient",
      patient_id: "pat-123",
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    };
    const reply = createMockReply();
    const result = await handleAuthMe({ user }, reply);
    expect(result).toEqual(
      expect.objectContaining({ patient_id: "pat-123" }),
    );
  });
});
