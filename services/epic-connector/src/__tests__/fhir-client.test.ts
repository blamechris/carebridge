/**
 * Unit tests for EpicFhirClient (#390).
 *
 * All tests run offline — fetch is mocked, sleep is a no-op so backoff
 * doesn't burn wall-clock time. The integration test against
 * fhir.epic.com is intentionally not in CI; it runs locally when the
 * caller has registered credentials.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { EpicFhirClient, EpicFhirError } from "../fhir-client.js";
import { EpicTokenClient } from "../token-client.js";
import type { EpicConfig } from "../config.js";
import type { FhirBundle, FhirResource, OperationOutcome } from "../fhir-types.js";

function makeConfig(privatePem: string): EpicConfig {
  return {
    clientId: "test-client-id",
    tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
    fhirBaseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/",
    privateKeyPem: privatePem,
    jwtKid: "test-kid",
  };
}

function makeTokenResponse() {
  return new Response(
    JSON.stringify({
      access_token: "fake-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "system/*.read",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonResponse<T>(body: T, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/fhir+json", ...(init.headers ?? {}) },
  });
}

function bundleOf(
  resources: FhirResource[],
  links: { relation: string; url: string }[] = [],
): FhirBundle {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    link: links,
    entry: resources.map((r) => ({ resource: r })),
  };
}

describe("EpicFhirClient (#390)", () => {
  let privatePem: string;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  function setup(responses: Array<Response | (() => Response)>) {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/token")) return makeTokenResponse();
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      return typeof next === "function" ? next() : next;
    });
    const config = makeConfig(privatePem);
    const tokens = new EpicTokenClient(config, fetchMock);
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const client = new EpicFhirClient(config, tokens, {
      fetchImpl: fetchMock,
      sleep: sleepMock,
      backoffBaseMs: 1,
    });
    return { client, fetchMock, sleepMock, tokens };
  }

  it("read() sends Authorization Bearer and returns the resource", async () => {
    const { client, fetchMock } = setup([
      jsonResponse<FhirResource>({ resourceType: "Patient", id: "p-1" }),
    ]);
    const patient = await client.read("Patient", "p-1");
    expect(patient).toEqual({ resourceType: "Patient", id: "p-1" });

    // First call is token; second is the FHIR request
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Patient/p-1",
    );
    expect(init.headers.Authorization).toBe("Bearer fake-token");
    expect(init.headers.Accept).toBe("application/fhir+json");
  });

  it("read() throws when the server returns an OperationOutcome", async () => {
    const { client } = setup([
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "no such patient" }],
      }),
    ]);
    await expect(client.read("Patient", "missing")).rejects.toThrow(
      /OperationOutcome: not-found — no such patient/,
    );
  });

  it("search() encodes params and returns the bundle", async () => {
    const bundle = bundleOf([{ resourceType: "Observation", id: "obs-1" }]);
    const { client, fetchMock } = setup([jsonResponse(bundle)]);

    const result = await client.search("Observation", {
      patient: "p-1",
      category: "vital-signs",
    });
    expect(result.entry?.[0]?.resource?.id).toBe("obs-1");
    const [url] = fetchMock.mock.calls[1]!;
    expect(url).toContain("Observation?");
    expect(url).toContain("patient=p-1");
    expect(url).toContain("category=vital-signs");
  });

  it("searchAll() walks Bundle.link rel=next to exhaust pages", async () => {
    const page1 = bundleOf(
      [
        { resourceType: "Observation", id: "obs-1" },
        { resourceType: "Observation", id: "obs-2" },
      ],
      [{ relation: "next", url: "https://fhir.epic.com/api/page2" }],
    );
    const page2 = bundleOf([{ resourceType: "Observation", id: "obs-3" }]);
    const { client, fetchMock } = setup([jsonResponse(page1), jsonResponse(page2)]);

    const ids: string[] = [];
    for await (const obs of client.searchAll("Observation", { patient: "p-1" })) {
      ids.push(obs.id!);
    }
    expect(ids).toEqual(["obs-1", "obs-2", "obs-3"]);
    // Token fetch + initial search + follow next link
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe("https://fhir.epic.com/api/page2");
  });

  it("retries once on 401 after invalidating the cached token", async () => {
    const { client, fetchMock, tokens } = setup([
      jsonResponse({}, { status: 401 }),
      jsonResponse<FhirResource>({ resourceType: "Patient", id: "p-1" }),
    ]);
    const invalidateSpy = vi.spyOn(tokens, "invalidate");

    const patient = await client.read("Patient", "p-1");
    expect(patient.id).toBe("p-1");
    expect(invalidateSpy).toHaveBeenCalledOnce();
    // Token (1) + first 401 (2) + retried token (3) + retried success (4)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry-loop on persistent 401 — surfaces the error", async () => {
    const { client } = setup([
      jsonResponse({}, { status: 401 }),
      jsonResponse({}, { status: 401 }),
    ]);
    await expect(client.read("Patient", "p-1")).rejects.toThrow(/401/);
  });

  it("respects Retry-After (seconds) on 429 and retries", async () => {
    const { client, fetchMock, sleepMock } = setup([
      jsonResponse({}, { status: 429, headers: { "Retry-After": "2" } }),
      jsonResponse<FhirResource>({ resourceType: "Patient", id: "p-1" }),
    ]);

    const patient = await client.read("Patient", "p-1");
    expect(patient.id).toBe("p-1");
    expect(sleepMock).toHaveBeenCalledOnce();
    expect(sleepMock.mock.calls[0]![0]).toBe(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("exponentially backs off on 5xx and gives up after maxRetries", async () => {
    // 4 failed responses = 1 initial + 3 retries; maxRetries=3 means
    // attempts 0,1,2,3 fail then throw.
    const responses = Array.from({ length: 4 }, () =>
      jsonResponse({}, { status: 503 }),
    );
    const { client, sleepMock } = setup(responses);

    await expect(client.read("Patient", "p-1")).rejects.toThrow(/4 attempts.*503/);
    // Sleep called 3 times (between attempts 0→1, 1→2, 2→3)
    expect(sleepMock).toHaveBeenCalledTimes(3);
    // backoffBase=1, expBackoff = 1, 2, 4 (+jitter up to 1ms each)
    expect(sleepMock.mock.calls[0]![0]).toBeGreaterThanOrEqual(1);
    expect(sleepMock.mock.calls[1]![0]).toBeGreaterThanOrEqual(2);
    expect(sleepMock.mock.calls[2]![0]).toBeGreaterThanOrEqual(4);
  });

  it("recovers from a single 503 by retrying", async () => {
    const { client, fetchMock } = setup([
      jsonResponse({}, { status: 503 }),
      jsonResponse<FhirResource>({ resourceType: "Patient", id: "p-1" }),
    ]);

    const patient = await client.read("Patient", "p-1");
    expect(patient.id).toBe("p-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces 4xx (non-401, non-429) errors immediately with body prefix", async () => {
    const { client } = setup([
      new Response("malformed search param", { status: 400 }),
    ]);
    await expect(client.read("Patient", "p-1")).rejects.toThrow(
      /400.*malformed search param/,
    );
  });

  // Typed wrappers — sanity checks that params end up on the URL
  it("searchObservations() emits expected URL params", async () => {
    const { client, fetchMock } = setup([jsonResponse(bundleOf([]))]);
    await client.searchObservations({
      patient: "p-1",
      category: "laboratory",
      _lastUpdated: "gt2026-01-01",
      _count: 50,
    });
    const url = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain("patient=p-1");
    expect(url).toContain("category=laboratory");
    expect(url).toContain("_lastUpdated=gt2026-01-01");
    expect(url).toContain("_count=50");
  });

  it("searchEncounters() includes _sort=-date", async () => {
    const { client, fetchMock } = setup([jsonResponse(bundleOf([]))]);
    await client.searchEncounters({ patient: "p-1", _sort: "-date" });
    const url = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain("_sort=-date");
  });

  // ── #1096 / #1099: structured error surface ───────────────────────
  // requestWithRetry now throws EpicFhirError instead of plain Error
  // so downstream code can check `err.hasIssueCode("59022")` rather
  // than substring-matching the message.

  it("throws EpicFhirError with parsed OperationOutcome on 4xx with FHIR body", async () => {
    const oo: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "invalid",
          details: {
            text: "Combination of parameters is not valid for any authorized sub-resource. No search was performed.",
            coding: [
              {
                system: "urn:oid:1.2.840.114350.1.13.0.1.7.2.657369",
                code: "59022",
                display:
                  "Combination of parameters is not valid for any authorized sub-resource.",
              },
            ],
          },
        },
      ],
    };
    const { client } = setup([jsonResponse(oo, { status: 400 })]);
    let thrown: unknown;
    try {
      await client.read("Patient", "p-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EpicFhirError);
    const err = thrown as EpicFhirError;
    expect(err.status).toBe(400);
    expect(err.operationOutcome).toBeDefined();
    expect(err.hasIssueCode("59022")).toBe(true);
    expect(err.hasIssueCode("59108")).toBe(false);
    // Message still carries the body so existing log/error consumers
    // that read `err.message` keep working.
    expect(err.message).toContain("400");
  });

  it("tryParseOperationOutcome rejects shapes where issue is not an array (#1103); hasIssueCode still safely returns false", async () => {
    // Epic edge proxies occasionally return OperationOutcome-shaped
    // JSON with a partial / null `issue` field. With the tightened
    // parser (#1103) such payloads are NOT promoted to a typed
    // OperationOutcome — `err.operationOutcome` stays undefined and
    // the sync-jobs substring fallback handles them.
    const malformed = {
      resourceType: "OperationOutcome",
      issue: null, // not an array → parser rejects
    };
    const { client } = setup([
      new Response(JSON.stringify(malformed), {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try {
      await client.read("Patient", "p-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EpicFhirError);
    const err = thrown as EpicFhirError;
    expect(err.operationOutcome).toBeUndefined();
    expect(() => err.hasIssueCode("59022")).not.toThrow();
    expect(err.hasIssueCode("59022")).toBe(false);
  });

  it("throws EpicFhirError without operationOutcome when the 4xx body is not JSON", async () => {
    // Epic edge proxies sometimes return HTML / plain text instead of
    // a FHIR OperationOutcome — the typed error must still construct
    // (body retained, operationOutcome undefined, hasIssueCode false).
    const { client } = setup([
      new Response("<html>502 Bad Gateway</html>", { status: 400 }),
    ]);
    let thrown: unknown;
    try {
      await client.read("Patient", "p-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EpicFhirError);
    const err = thrown as EpicFhirError;
    expect(err.operationOutcome).toBeUndefined();
    expect(err.body).toContain("502 Bad Gateway");
    expect(err.hasIssueCode("59022")).toBe(false);
  });

  // ── #1103: tryParseOperationOutcome edge-case rejection ─────────
  // The parser is the trust boundary between raw Epic bodies and typed
  // OperationOutcome data downstream consumers `hasIssueCode()` against.
  // If the parser accepts a malformed shape, `hasIssueCode` would
  // either silently misreport or throw on iteration. After tightening
  // (#1103, #1104) the parser only promotes payloads that pass these
  // structural checks:
  //   1. JSON parses to a plain object (not "string" / number / array / null)
  //   2. resourceType === "OperationOutcome"
  //   3. Array.isArray(issue)
  //   4. every issue.details.coding[*] has a `code` string

  it("tryParseOperationOutcome rejects valid-JSON string body (not an object)", async () => {
    const { client } = setup([
      new Response('"just a string"', {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  it("tryParseOperationOutcome rejects valid-JSON array body (not an object)", async () => {
    const { client } = setup([
      new Response("[1,2,3]", {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  it("tryParseOperationOutcome rejects valid-JSON null body", async () => {
    const { client } = setup([
      new Response("null", {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  it("tryParseOperationOutcome rejects object without resourceType", async () => {
    const { client } = setup([
      new Response(JSON.stringify({ issue: [] }), {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  it("tryParseOperationOutcome rejects object with resourceType !== OperationOutcome", async () => {
    const { client } = setup([
      new Response(JSON.stringify({ resourceType: "Patient", id: "p-1" }), {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  // ── #1104: tightened OperationOutcomeIssueCoding.code ───────────
  // Epic always emits a `code` on its coding entries; if a payload
  // lacks one in any coding, that signals the response isn't from
  // Epic (or Epic edge proxy mangled it). Reject rather than promote
  // a half-valid OperationOutcome that future hasIssueCode() callers
  // might rely on.

  it("tryParseOperationOutcome rejects OperationOutcome where any coding entry lacks `code` (#1104)", async () => {
    const malformed = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "invalid",
          details: {
            coding: [
              { system: "urn:oid:1.2.840.114350.1.13.0.1.7.2.657369" /* code: missing */ },
            ],
          },
        },
      ],
    };
    const { client } = setup([
      new Response(JSON.stringify(malformed), {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeUndefined();
  });

  it("tryParseOperationOutcome accepts an OperationOutcome whose issue has no coding at all (details.text-only)", async () => {
    // No coding to validate → the #1104 guard doesn't apply; payload
    // is still a structurally valid OperationOutcome.
    const valid = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "invalid",
          details: { text: "Some Epic error" },
        },
      ],
    };
    const { client } = setup([
      new Response(JSON.stringify(valid), {
        status: 400,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    ]);
    let thrown: unknown;
    try { await client.read("Patient", "p-1"); } catch (err) { thrown = err; }
    expect((thrown as EpicFhirError).operationOutcome).toBeDefined();
    expect((thrown as EpicFhirError).hasIssueCode("59022")).toBe(false);
  });

  // ── #1101: operationOutcomeError throws EpicFhirError ───────────
  // Pre-#1101, `client.read()` against a 200 response with an
  // OperationOutcome body threw a plain Error — defeating the whole
  // structured-error story for the read/create/update paths.
  // After #1101 it throws EpicFhirError with operationOutcome
  // populated, so the same hasIssueCode() check works for 2xx-with-OO
  // responses as for 4xx-with-OO responses.

  it("client.read against a 200 with OperationOutcome body throws EpicFhirError (#1101)", async () => {
    const oo: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "not-found",
          details: {
            text: "Resource not found",
            coding: [{ system: "epic", code: "59022" }],
          },
        },
      ],
    };
    const { client } = setup([jsonResponse(oo, { status: 200 })]);
    let thrown: unknown;
    try { await client.read("Patient", "missing-id"); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(EpicFhirError);
    const err = thrown as EpicFhirError;
    expect(err.status).toBe(200);
    expect(err.operationOutcome).toBeDefined();
    expect(err.hasIssueCode("59022")).toBe(true);
  });

  it("throws EpicFhirError with parsed OperationOutcome after exhausting 5xx retries", async () => {
    const oo: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "exception",
          details: {
            text: "Internal server error",
            coding: [{ code: "INTERNAL" }],
          },
        },
      ],
    };
    const { client } = setup([
      jsonResponse(oo, { status: 503 }),
      jsonResponse(oo, { status: 503 }),
      jsonResponse(oo, { status: 503 }),
      jsonResponse(oo, { status: 503 }),
    ]);
    let thrown: unknown;
    try {
      await client.read("Patient", "p-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EpicFhirError);
    const err = thrown as EpicFhirError;
    expect(err.status).toBe(503);
    expect(err.operationOutcome).toBeDefined();
    expect(err.hasIssueCode("INTERNAL")).toBe(true);
  });

  it("treats absolute URLs (Bundle.link.url) verbatim", async () => {
    // Page 1 link.next points to a different host (Epic may return
    // absolute URLs with the FHIR base baked in)
    const page1 = bundleOf(
      [{ resourceType: "Patient", id: "p-1" }],
      [{ relation: "next", url: "https://epic.example.com/explicit-next-url" }],
    );
    const page2 = bundleOf([{ resourceType: "Patient", id: "p-2" }]);
    const { client, fetchMock } = setup([jsonResponse(page1), jsonResponse(page2)]);

    for await (const _ of client.searchAll("Patient")) {
      // no-op — we just need to drive the iterator
    }
    expect(fetchMock.mock.calls[2]![0]).toBe(
      "https://epic.example.com/explicit-next-url",
    );
  });
});
