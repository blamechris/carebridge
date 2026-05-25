/**
 * Open-redirect hardening on GET /auth/epic/authorize (issue #1185).
 *
 * The handler previously stored `request.query.redirect` verbatim in launch
 * state; the callback later did `reply.redirect(finalUrl)` on whatever came
 * back. Anyone crafting the URL by hand could land a logged-in clinician on
 * an attacker-controlled origin after the OAuth dance.
 *
 * We now validate the redirect on entry: it must parse as a same-origin
 * path (starts with `/`, no scheme, no protocol-relative `//`, no Windows
 * `\\` trick). Reject with 400 otherwise.
 *
 * These tests boot a minimal Fastify server with a stub user preHandler
 * and stub the epic-connector orchestrator so beginLaunch doesn't try to
 * fetch SMART configuration over the network.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Mocks — hoisted above the route-module import
// ---------------------------------------------------------------------------

interface CapturedBeginLaunchArgs {
  iss: string;
  launch?: string;
  userId: string;
  redirectUri: string;
  clientId: string;
  postLaunchRedirect: string;
}

const capturedBeginLaunchArgs: CapturedBeginLaunchArgs[] = [];
const beginLaunchMock = vi.fn(async (args: CapturedBeginLaunchArgs) => {
  capturedBeginLaunchArgs.push(args);
  return {
    authorizeUrl:
      "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize?state=test-state",
    state: "test-state",
  };
});

vi.mock("@carebridge/epic-connector", () => {
  class InMemoryLaunchStateStore {
    async set() {}
    async get() {
      return null;
    }
    async delete() {}
  }
  class RedisLaunchStateStore {
    async set() {}
    async get() {
      return null;
    }
    async delete() {}
  }
  return {
    beginLaunch: beginLaunchMock,
    completeLaunch: vi.fn(),
    InMemoryLaunchStateStore,
    RedisLaunchStateStore,
  };
});

vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Env must be set before the route module imports `process.env`.
process.env.EPIC_CLIENT_ID = "test-client-id";
process.env.EPIC_APP_LAUNCH_REDIRECT_URI =
  "https://app.carebridge.test/auth/epic/callback";

const { registerEpicAuthRoutes } = await import("../routes/epic-auth.js");

// ---------------------------------------------------------------------------
// Server builder
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: "user-1185-test",
  email: "redirect-test@carebridge.dev",
  name: "Redirect Test",
  role: "physician" as const,
  is_active: true,
};

function buildServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  // Stub-auth preHandler — mimics what authMiddleware does for real
  // sessions, but driven by a header so each test can opt in.
  server.addHook("preHandler", async (req) => {
    if (req.headers["x-test-auth"] === "1") {
      (req as unknown as Record<string, unknown>).user = TEST_USER;
    }
  });

  registerEpicAuthRoutes(server);
  return server;
}

const ISS = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /auth/epic/authorize — redirect validation (#1185)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    capturedBeginLaunchArgs.length = 0;
    beginLaunchMock.mockClear();
  });

  it("accepts same-origin path '/settings/integrations' and forwards it to launch state", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=/settings/integrations`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(302);
    expect(beginLaunchMock).toHaveBeenCalledTimes(1);
    expect(capturedBeginLaunchArgs[0]?.postLaunchRedirect).toBe(
      "/settings/integrations",
    );
  });

  it("rejects absolute URL ?redirect=https://attacker.example with 400", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=https://attacker.example`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(400);
    expect(beginLaunchMock).not.toHaveBeenCalled();
    const body = response.json() as { error: string };
    expect(body.error).toBe("invalid_redirect");
  });

  it("rejects protocol-relative ?redirect=//attacker.example with 400", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=${encodeURIComponent("//attacker.example")}`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(400);
    expect(beginLaunchMock).not.toHaveBeenCalled();
  });

  it("rejects javascript: scheme injection ?redirect=javascript:alert(1) with 400", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=${encodeURIComponent("javascript:alert(1)")}`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(400);
    expect(beginLaunchMock).not.toHaveBeenCalled();
  });

  it("rejects Windows-style backslash ?redirect=\\\\attacker.example with 400", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=${encodeURIComponent("\\\\attacker.example")}`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(400);
    expect(beginLaunchMock).not.toHaveBeenCalled();
  });

  it("rejects data: URI ?redirect=data:text/html,<script>alert(1)</script> with 400", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=${encodeURIComponent("data:text/html,<script>alert(1)</script>")}`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(400);
    expect(beginLaunchMock).not.toHaveBeenCalled();
  });

  it("accepts paths with traversal segments (path traversal is the receiver's problem)", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=${encodeURIComponent("/../../../etc/passwd")}`,
      headers: { "x-test-auth": "1" },
    });

    // The redirect validator's job is to keep the user on our origin, not
    // to second-guess what their app does with the path.
    expect(response.statusCode).toBe(302);
    expect(beginLaunchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to '/' when ?redirect is absent", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(302);
    expect(beginLaunchMock).toHaveBeenCalledTimes(1);
    expect(capturedBeginLaunchArgs[0]?.postLaunchRedirect).toBe("/");
  });

  it("treats empty ?redirect= as absent and defaults to '/'", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/auth/epic/authorize?iss=${encodeURIComponent(ISS)}&redirect=`,
      headers: { "x-test-auth": "1" },
    });

    expect(response.statusCode).toBe(302);
    expect(beginLaunchMock).toHaveBeenCalledTimes(1);
    expect(capturedBeginLaunchArgs[0]?.postLaunchRedirect).toBe("/");
  });
});
