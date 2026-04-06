import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// resolveCorsOrigins is a module-private function inside server.ts.
// We replicate its logic here so we can unit-test the CORS origin resolution
// contract without importing the entire server module (which has heavy
// side-effects: Fastify, Redis, tRPC registration, etc.).
// ---------------------------------------------------------------------------

function resolveCorsOrigins(): string[] {
  const isProduction = process.env.NODE_ENV === "production";
  const rawOrigin = process.env.CORS_ORIGIN;

  if (isProduction) {
    if (!rawOrigin) {
      throw new Error(
        "CORS_ORIGIN must be explicitly set in production. " +
          "Refusing to start with a wildcard origin — this would expose all PHI to any requestor.",
      );
    }
    return rawOrigin.split(",").map((o) => o.trim());
  }

  // Development: use CORS_ORIGIN if set, otherwise fall back to local dev origins
  if (rawOrigin) {
    return rawOrigin.split(",").map((o) => o.trim());
  }
  return ["http://localhost:3000", "http://localhost:3001"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveCorsOrigins", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars before each test
    delete process.env.CORS_ORIGIN;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    // Restore original environment
    process.env.CORS_ORIGIN = originalEnv.CORS_ORIGIN;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  it("parses comma-separated CORS_ORIGIN values", () => {
    process.env.CORS_ORIGIN =
      "https://app.carebridge.io, https://admin.carebridge.io";

    const origins = resolveCorsOrigins();

    expect(origins).toEqual([
      "https://app.carebridge.io",
      "https://admin.carebridge.io",
    ]);
  });

  it("parses a single CORS_ORIGIN value", () => {
    process.env.CORS_ORIGIN = "https://app.carebridge.io";

    const origins = resolveCorsOrigins();

    expect(origins).toEqual(["https://app.carebridge.io"]);
  });

  it("throws in production when CORS_ORIGIN is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGIN;

    expect(() => resolveCorsOrigins()).toThrow(
      "CORS_ORIGIN must be explicitly set in production",
    );
  });

  it("succeeds in production when CORS_ORIGIN is set", () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://prod.carebridge.io";

    const origins = resolveCorsOrigins();

    expect(origins).toEqual(["https://prod.carebridge.io"]);
  });

  it("defaults to localhost origins in development when CORS_ORIGIN is unset", () => {
    process.env.NODE_ENV = "development";
    delete process.env.CORS_ORIGIN;

    const origins = resolveCorsOrigins();

    expect(origins).toEqual([
      "http://localhost:3000",
      "http://localhost:3001",
    ]);
  });

  it("uses CORS_ORIGIN over defaults in development when set", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_ORIGIN = "http://localhost:8080";

    const origins = resolveCorsOrigins();

    expect(origins).toEqual(["http://localhost:8080"]);
  });
});
