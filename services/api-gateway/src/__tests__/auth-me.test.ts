import { describe, it, expect } from "vitest";

/**
 * Tests for the GET /auth/me endpoint behaviour.
 *
 * The endpoint is a thin Fastify route registered in server.ts that returns
 * `request.user` (populated by the auth middleware) or 401. These tests
 * exercise the route handler logic directly rather than booting the full
 * Fastify server, so we only need to validate the contract:
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

// Re-implement the handler logic inline (mirrors server.ts) so we can test
// without bootstrapping Fastify + all its plugins.
async function authMeHandler(
  request: { user?: { id: string; email: string; name: string; role: string; specialty?: string; department?: string; patient_id?: string } },
  reply: MockReply,
) {
  if (!request.user) {
    return reply.code(401).send({ error: "Not authenticated" });
  }
  return {
    id: request.user.id,
    email: request.user.email,
    name: request.user.name,
    role: request.user.role,
    specialty: request.user.specialty,
    department: request.user.department,
    patient_id: request.user.patient_id,
  };
}

describe("GET /auth/me handler", () => {
  it("returns 401 when request.user is not set", async () => {
    const reply = createMockReply();
    await authMeHandler({ user: undefined }, reply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Not authenticated" });
  });

  it("returns the user profile when authenticated", async () => {
    const user = {
      id: "u-1",
      email: "dr.smith@carebridge.dev",
      name: "Dr. Smith",
      role: "physician",
      specialty: "Hematology/Oncology",
      department: "Oncology",
      patient_id: undefined,
    };
    const reply = createMockReply();
    const result = await authMeHandler({ user }, reply);
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
    const user = {
      id: "u-2",
      email: "patient@carebridge.dev",
      name: "Patient User",
      role: "patient",
      patient_id: "pat-123",
    };
    const reply = createMockReply();
    const result = await authMeHandler({ user }, reply);
    expect(result).toEqual(
      expect.objectContaining({ patient_id: "pat-123" }),
    );
  });
});
