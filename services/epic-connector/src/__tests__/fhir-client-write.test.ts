/**
 * Tests for the EpicFhirClient write methods (#393).
 *
 * Verifies the POST/PUT request shape, retry behavior, and
 * OperationOutcome error handling.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { EpicFhirClient } from "../fhir-client.js";
import { EpicTokenClient } from "../token-client.js";
import type { EpicConfig } from "../config.js";

function tokenResponse() {
  return new Response(
    JSON.stringify({
      access_token: "tok",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "system/*.write",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonFhir(body: unknown, init: ResponseInit = { status: 201 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/fhir+json", ...(init.headers ?? {}) },
  });
}

function makeConfig(privatePem: string): EpicConfig {
  return {
    clientId: "test-client",
    tokenUrl: "https://fhir.epic.com/oauth2/token",
    fhirBaseUrl: "https://fhir.epic.com/api/FHIR/R4/",
    privateKeyPem: privatePem,
    jwtKid: "test-kid",
  };
}

describe("EpicFhirClient.createResource / updateResource (#393)", () => {
  let privatePem: string;
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  function setup(responses: Response[]) {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/token")) return tokenResponse();
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      return next;
    });
    const config = makeConfig(privatePem);
    const tokens = new EpicTokenClient(config, fetchMock);
    const client = new EpicFhirClient(config, tokens, {
      fetchImpl: fetchMock,
      sleep: vi.fn().mockResolvedValue(undefined),
      backoffBaseMs: 1,
    });
    return { client, fetchMock };
  }

  it("createResource POSTs FHIR JSON to the base URL + resource type", async () => {
    const { client, fetchMock } = setup([
      jsonFhir({ resourceType: "Flag", id: "epic-flag-1" }, { status: 201 }),
    ]);

    const result = await client.createResource("Flag", {
      resourceType: "Flag",
      status: "active",
      code: { text: "demo" },
    });

    expect(result).toMatchObject({ resourceType: "Flag", id: "epic-flag-1" });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://fhir.epic.com/api/FHIR/R4/Flag");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/fhir+json");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ resourceType: "Flag" });
  });

  it("updateResource PUTs to /{type}/{id}", async () => {
    const { client, fetchMock } = setup([
      jsonFhir({ resourceType: "Flag", id: "epic-flag-1" }),
    ]);

    await client.updateResource("Flag", "epic-flag-1", {
      resourceType: "Flag",
      id: "epic-flag-1",
      status: "inactive",
      code: { text: "demo" },
    });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://fhir.epic.com/api/FHIR/R4/Flag/epic-flag-1");
    expect(init.method).toBe("PUT");
  });

  it("throws on OperationOutcome response (write rejected by Epic)", async () => {
    const { client } = setup([
      jsonFhir(
        {
          resourceType: "OperationOutcome",
          issue: [
            { severity: "error", code: "invariant", diagnostics: "missing subject" },
          ],
        },
        { status: 422 },
      ),
    ]);

    await expect(
      client.createResource("Flag", {
        resourceType: "Flag",
        status: "active",
        code: { text: "x" },
      }),
    ).rejects.toThrow();
  });

  it("retries on 503 then succeeds (same backoff path as reads)", async () => {
    const { client, fetchMock } = setup([
      jsonFhir({}, { status: 503 }),
      jsonFhir({ resourceType: "Flag", id: "epic-flag-2" }, { status: 201 }),
    ]);

    const result = await client.createResource("Flag", {
      resourceType: "Flag",
      status: "active",
      code: { text: "x" },
    });

    expect(result).toMatchObject({ id: "epic-flag-2" });
    // Token + 503 + retry = 3 fetches
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
