import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the DB handle used by createContext. The context builder only calls
// getDb() to store the handle on ctx.db — we never touch it in these tests,
// so a bare sentinel is sufficient.
// ---------------------------------------------------------------------------

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ __db: "mock" }),
}));

import { createContext, resolveClientIp } from "../context.js";

/**
 * Build a minimal Fastify-shaped request for resolveClientIp. Only `ip`
 * matters — other fields are omitted to avoid coupling the test to the
 * Fastify surface area.
 */
function makeReq(ip: unknown): { ip: string } {
  return { ip: ip as string };
}

// ---------------------------------------------------------------------------
// resolveClientIp — unit tests for the pure resolver
// ---------------------------------------------------------------------------

describe("resolveClientIp", () => {
  it("returns Fastify's request.ip verbatim when populated", () => {
    expect(resolveClientIp(makeReq("203.0.113.42"))).toBe("203.0.113.42");
  });

  it("trims whitespace around the IP", () => {
    expect(resolveClientIp(makeReq("  198.51.100.7  "))).toBe("198.51.100.7");
  });

  it("returns null when request.ip is an empty string", () => {
    expect(resolveClientIp(makeReq(""))).toBeNull();
  });

  it("returns null when request.ip is whitespace-only", () => {
    expect(resolveClientIp(makeReq("   "))).toBeNull();
  });

  it("returns null when request.ip is undefined", () => {
    expect(resolveClientIp(makeReq(undefined))).toBeNull();
  });

  it("preserves IPv6 addresses without modification", () => {
    expect(resolveClientIp(makeReq("2001:db8::1"))).toBe("2001:db8::1");
  });

  it("preserves IPv6-mapped IPv4 addresses", () => {
    expect(resolveClientIp(makeReq("::ffff:192.0.2.1"))).toBe(
      "::ffff:192.0.2.1",
    );
  });

  // Security regression guard: we intentionally do NOT read x-forwarded-for
  // directly. When Fastify's trustProxy is disabled (the current gateway
  // config), request.ip is the TCP peer and XFF must be ignored — otherwise
  // a malicious client could spoof an IP by setting the header itself.
  // Fastify handles XFF correctly only when trustProxy is explicitly on.
  it("does NOT read x-forwarded-for directly; relies on Fastify's request.ip", () => {
    // Even with a spoofed XFF header, resolver returns request.ip.
    const reqWithSpoofedHeader = {
      ip: "10.0.0.1",
      headers: { "x-forwarded-for": "evil.example.com, 1.2.3.4" },
    };
    expect(resolveClientIp(reqWithSpoofedHeader)).toBe("10.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// createContext — integration with the Fastify context options shape
// ---------------------------------------------------------------------------

describe("createContext — clientIp wiring", () => {
  function makeOpts(
    overrides: Partial<{ ip: string; user: unknown; sessionId: string }> = {},
  ) {
    return {
      req: {
        ip: overrides.ip ?? "127.0.0.1",
        user: overrides.user,
        sessionId: overrides.sessionId,
      },
      res: {
        header: vi.fn(),
      },
    } as unknown as Parameters<typeof createContext>[0];
  }

  it("populates ctx.clientIp from Fastify request.ip", async () => {
    const ctx = await createContext(makeOpts({ ip: "203.0.113.99" }));
    expect(ctx.clientIp).toBe("203.0.113.99");
  });

  it("ctx.clientIp is null when the transport yields no IP", async () => {
    const ctx = await createContext(makeOpts({ ip: "" }));
    expect(ctx.clientIp).toBeNull();
  });

  it("trims the resolved IP", async () => {
    const ctx = await createContext(makeOpts({ ip: "  192.0.2.4  " }));
    expect(ctx.clientIp).toBe("192.0.2.4");
  });

  it("leaves the rest of the context shape intact", async () => {
    const ctx = await createContext(makeOpts({ ip: "10.0.0.5" }));
    expect(ctx).toMatchObject({
      user: null,
      sessionId: null,
      clientIp: "10.0.0.5",
    });
    expect(typeof ctx.requestId).toBe("string");
    expect(ctx.requestId.length).toBeGreaterThan(0);
    expect(typeof ctx.setHeader).toBe("function");
  });
});
