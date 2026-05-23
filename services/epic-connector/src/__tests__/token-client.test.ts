/**
 * Unit tests for EpicTokenClient (#389).
 *
 * Mocks fetch so the tests run offline. Real-Epic integration is gated
 * on EPIC_CLIENT_ID and runs locally when the user has credentials.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { EpicTokenClient, DEFAULT_SYSTEM_SCOPES } from "../token-client.js";
import type { EpicConfig } from "../config.js";

function makeConfig(privatePem: string): EpicConfig {
  return {
    clientId: "test-client-id-xyz",
    tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    fhirBaseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/",
    privateKeyPem: privatePem,
    jwtKid: "test-kid",
  };
}

function tokenResponse(opts: { expires_in?: number; access_token?: string } = {}) {
  return new Response(
    JSON.stringify({
      access_token: opts.access_token ?? "fake-access-token",
      expires_in: opts.expires_in ?? 3600,
      token_type: "Bearer",
      scope: DEFAULT_SYSTEM_SCOPES.join(" "),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("EpicTokenClient (#389)", () => {
  let privatePem: string;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  it("requests a token via client_credentials with a JWT assertion", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse());
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(body.get("client_assertion")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.get("scope")).toBe(DEFAULT_SYSTEM_SCOPES.join(" "));
  });

  it("returns the parsed access_token from a 200 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "abc-123" }),
    );
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);
    const token = await client.getAccessToken();
    expect(token).toBe("abc-123");
  });

  it("caches the token and serves subsequent calls without re-fetching", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse());
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await client.getAccessToken();
    await client.getAccessToken();
    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-requests when the cached token has less than 60s of lifetime left", async () => {
    let now = 1_700_000_000_000;
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => tokenResponse({ expires_in: 100 }));
    const client = new EpicTokenClient(
      makeConfig(privatePem),
      fetchMock,
      () => now,
    );

    await client.getAccessToken();
    // Jump forward 50 seconds — still within the 60s refresh buffer
    // window (100 - 50 = 50 remaining ≤ 60 → re-request).
    now += 50_000;
    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-request when cache still has > 60s of lifetime", async () => {
    let now = 1_700_000_000_000;
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse({ expires_in: 3600 }));
    const client = new EpicTokenClient(
      makeConfig(privatePem),
      fetchMock,
      () => now,
    );

    await client.getAccessToken();
    now += 600_000; // 10 min later — token still has ~50 min left
    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("invalidate() forces a fresh token on next call", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse());
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await client.getAccessToken();
    client.invalidate();
    await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on non-2xx response without leaking the assertion body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("invalid_client_assertion_or_signature", { status: 400 }),
    );
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await expect(client.getAccessToken()).rejects.toThrow(/Epic token endpoint returned 400/);
  });

  it("accepts custom scope override", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse());
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await client.getAccessToken(["system/Patient.read"]);

    const body = new URLSearchParams(
      fetchMock.mock.calls[0]![1].body as string,
    );
    expect(body.get("scope")).toBe("system/Patient.read");
  });
});
