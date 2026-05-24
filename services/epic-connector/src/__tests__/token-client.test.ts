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

  it("coalesces concurrent callers into a single in-flight fetch (#1089)", async () => {
    // Hold the fetch response until we explicitly resolve it, so all
    // callers race for the same in-flight promise before any of them
    // see a cached value.
    let resolveFetch: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => pendingResponse);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    // Fire 5 concurrent getAccessToken() calls before the first fetch
    // resolves.
    const callers = Array.from({ length: 5 }, () => client.getAccessToken());

    // Now release the underlying token fetch.
    resolveFetch!(tokenResponse({ access_token: "coalesced-token" }));

    const tokens = await Promise.all(callers);

    // Every caller should receive the same token, and only ONE fetch
    // should have hit the network.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokens).toEqual([
      "coalesced-token",
      "coalesced-token",
      "coalesced-token",
      "coalesced-token",
      "coalesced-token",
    ]);
  });

  it("invalidate() clears the in-flight promise so the next call fetches afresh (#1089)", async () => {
    // Set up a pending fetch that we will invalidate before resolving.
    // After invalidate(), the next call should kick off its own fetch
    // rather than reusing the dropped in-flight promise.
    //
    // CRITICAL ordering (#1143): we resolve the SECOND fetch FIRST and
    // the FIRST (invalidated) fetch LAST. This is the real-world race —
    // the dropped promise often settles after the retry has already
    // populated the cache with a fresh token. Without a generation
    // guard, the late-resolving first fetch overwrites the fresh cache
    // with stale data and the next caller reads a stale token.
    let resolveFirst: (response: Response) => void;
    let resolveSecond: (response: Response) => void;
    const firstPending = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(() => secondPending);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    // Kick off the first call but do not await it — it is in-flight.
    const firstCall = client.getAccessToken();
    // While in-flight, invalidate clears the in-flight reference.
    client.invalidate();
    // The next call should NOT reuse the dropped promise; it should
    // start a brand-new fetch.
    const secondCall = client.getAccessToken();

    // Resolve the SECOND (retry) fetch first — it populates the cache
    // with the fresh token.
    resolveSecond!(tokenResponse({ access_token: "second-token" }));
    await secondCall;
    // NOW resolve the FIRST (invalidated, stale) fetch. It must NOT
    // overwrite the cache.
    resolveFirst!(tokenResponse({ access_token: "first-token" }));
    const first = await firstCall;
    const second = await secondCall;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toBe("first-token");
    expect(second).toBe("second-token");

    // The race-critical assertion: after both promises settle, a
    // subsequent caller must see the FRESH (second) token from cache,
    // not the stale (first) one that resolved last.
    const subsequent = await client.getAccessToken();
    expect(subsequent).toBe("second-token");
    // No additional fetch — third call served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite cache when an invalidated fetch resolves after a fresh fetch (#1143)", async () => {
    // Race sequence:
    //   1. Call A starts -> in-flight P1
    //   2. (Server 401 elsewhere) -> tokens.invalidate() drops P1 + cache
    //   3. Retry: Call B starts -> in-flight P2 -> P2 resolves fresh
    //   4. P1 finally resolves with STALE token
    //   5. Next caller must read the FRESH token, not the stale one.
    let resolveFirst: (response: Response) => void;
    let resolveSecond: (response: Response) => void;
    const firstPending = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(() => secondPending);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    const firstCall = client.getAccessToken();
    client.invalidate();
    const secondCall = client.getAccessToken();

    // Fresh retry resolves first and populates the cache.
    resolveSecond!(tokenResponse({ access_token: "fresh-token" }));
    expect(await secondCall).toBe("fresh-token");

    // Now the stale, invalidated fetch finally settles. It MUST NOT
    // write back to this.cached — that would be a stale overwrite.
    resolveFirst!(tokenResponse({ access_token: "stale-token" }));
    await firstCall;

    // The fresh token from the retry remains cached.
    const nextToken = await client.getAccessToken();
    expect(nextToken).toBe("fresh-token");
    // Still only 2 underlying fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce concurrent callers requesting different scope sets (#1144)", async () => {
    // Two concurrent callers with different scope sets must each receive
    // a token fetched with their own scopes — not be served whichever
    // narrow-scope token happened to be in flight first. Otherwise a
    // caller that requested ["system/Patient.read", "system/Observation.read"]
    // could receive a token issued only for ["system/Patient.read"] and
    // then fail mid-call when it tried to read Observation resources.
    let resolveNarrow: (response: Response) => void;
    let resolveWide: (response: Response) => void;
    const narrowPending = new Promise<Response>((resolve) => {
      resolveNarrow = resolve;
    });
    const widePending = new Promise<Response>((resolve) => {
      resolveWide = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => narrowPending)
      .mockImplementationOnce(() => widePending);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    const narrowCall = client.getAccessToken(["system/Patient.read"]);
    const wideCall = client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);

    // Each scope set must drive its OWN fetch — coalescing would
    // collapse these to one.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveNarrow!(tokenResponse({ access_token: "narrow-token" }));
    resolveWide!(tokenResponse({ access_token: "wide-token" }));

    expect(await narrowCall).toBe("narrow-token");
    expect(await wideCall).toBe("wide-token");

    // Verify each fetch carried the correct scope string.
    const narrowBody = new URLSearchParams(
      fetchMock.mock.calls[0]![1].body as string,
    );
    const wideBody = new URLSearchParams(
      fetchMock.mock.calls[1]![1].body as string,
    );
    expect(narrowBody.get("scope")).toBe("system/Patient.read");
    expect(wideBody.get("scope")?.split(" ").sort()).toEqual(
      ["system/Observation.read", "system/Patient.read"],
    );
  });

  it("coalesces concurrent callers with the same scopes regardless of order (#1144)", async () => {
    // ["a", "b"] and ["b", "a"] are semantically identical scope sets —
    // both must hash to the same key and share the in-flight fetch.
    let resolveFetch: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => pendingResponse);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    const callA = client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);
    const callB = client.getAccessToken([
      "system/Observation.read",
      "system/Patient.read",
    ]);

    resolveFetch!(tokenResponse({ access_token: "shared-token" }));

    expect(await callA).toBe("shared-token");
    expect(await callB).toBe("shared-token");
    // Only ONE network round-trip despite two callers.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caches per scope key — different scope sets don't reuse each other's cache (#1144)", async () => {
    // Sequential calls (not concurrent) with different scope sets must
    // each issue their own fetch, because the cached token for one scope
    // set may not satisfy a different scope set.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: "narrow-token" }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "wide-token" }));
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    const narrow = await client.getAccessToken(["system/Patient.read"]);
    const wide = await client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);

    expect(narrow).toBe("narrow-token");
    expect(wide).toBe("wide-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Repeating the narrow request should hit the per-scope cache, not
    // refetch and not be served the wide token.
    const narrowAgain = await client.getAccessToken(["system/Patient.read"]);
    expect(narrowAgain).toBe("narrow-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidate() clears all per-scope cache entries (#1144)", async () => {
    // After invalidate() drops the per-scope cache, the next call for
    // ANY scope set must refetch — no scope key should survive.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: "narrow-1" }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "wide-1" }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "narrow-2" }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "wide-2" }));
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await client.getAccessToken(["system/Patient.read"]);
    await client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    client.invalidate();

    const narrow = await client.getAccessToken(["system/Patient.read"]);
    const wide = await client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);
    expect(narrow).toBe("narrow-2");
    expect(wide).toBe("wide-2");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("generation guard works per scope key — stale write to one key doesn't pollute another (#1144)", async () => {
    // Race sequence:
    //   1. Caller A starts -> in-flight P_narrow for narrow scopes
    //   2. Caller B starts -> in-flight P_wide for wide scopes
    //   3. invalidate() drops both in-flight slots + cache, bumps generation
    //   4. Retry for narrow scopes resolves first -> fresh narrow token cached
    //   5. STALE P_wide finally resolves -> must NOT write to the wide
    //      cache entry (its generation no longer matches), and must NOT
    //      pollute the unrelated narrow entry either.
    let resolveNarrow1: (response: Response) => void;
    let resolveWide1: (response: Response) => void;
    let resolveNarrow2: (response: Response) => void;
    const narrow1Pending = new Promise<Response>((resolve) => {
      resolveNarrow1 = resolve;
    });
    const wide1Pending = new Promise<Response>((resolve) => {
      resolveWide1 = resolve;
    });
    const narrow2Pending = new Promise<Response>((resolve) => {
      resolveNarrow2 = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => narrow1Pending)
      .mockImplementationOnce(() => wide1Pending)
      .mockImplementationOnce(() => narrow2Pending);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    const narrowCall1 = client.getAccessToken(["system/Patient.read"]);
    const wideCall1 = client.getAccessToken([
      "system/Patient.read",
      "system/Observation.read",
    ]);

    // Drop both in-flight requests; bumps generation.
    client.invalidate();

    // Retry just the narrow scope.
    const narrowCall2 = client.getAccessToken(["system/Patient.read"]);
    resolveNarrow2!(tokenResponse({ access_token: "narrow-fresh" }));
    expect(await narrowCall2).toBe("narrow-fresh");

    // Late-arriving STALE responses from the invalidated fetches.
    resolveNarrow1!(tokenResponse({ access_token: "narrow-stale" }));
    resolveWide1!(tokenResponse({ access_token: "wide-stale" }));
    await narrowCall1;
    await wideCall1;

    // Cached narrow token must remain the fresh one.
    const narrowAgain = await client.getAccessToken(["system/Patient.read"]);
    expect(narrowAgain).toBe("narrow-fresh");
    // No extra fetches — served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears the in-flight promise when the token request fails (#1089)", async () => {
    // After a fetch failure, the in-flight promise must be cleared so a
    // retry can issue a fresh request — otherwise every subsequent
    // caller would await (and reject from) the same poisoned promise.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("invalid_client_assertion_or_signature", { status: 400 }),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: "after-retry" }));
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    await expect(client.getAccessToken()).rejects.toThrow(/400/);
    const recovered = await client.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered).toBe("after-retry");
  });

  it("emits a debug log when a stale-generation fetch is dropped (#1161)", async () => {
    // After #1143 introduced the generation guard, a stale fetch that
    // resolves AFTER invalidate() silently refuses to write back to the
    // cache. Operators need observability into how often that happens —
    // during a 401-driven invalidate storm the silent skip looked like a
    // black hole. Assert that the skip path emits a structured debug log
    // carrying both the captured and current generation counters so the
    // churn is visible in log aggregators.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let resolveFirst: (response: Response) => void;
    let resolveSecond: (response: Response) => void;
    const firstPending = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(() => secondPending);
    const client = new EpicTokenClient(makeConfig(privatePem), fetchMock);

    // P1 in-flight -> invalidate() bumps generation -> P2 in-flight ->
    // resolve P2 first (fresh) then P1 last (stale, must be dropped +
    // logged).
    const firstCall = client.getAccessToken();
    client.invalidate();
    const secondCall = client.getAccessToken();

    resolveSecond!(tokenResponse({ access_token: "fresh-token" }));
    await secondCall;
    resolveFirst!(tokenResponse({ access_token: "stale-token" }));
    await firstCall;

    // Find the debug log emitted from the stale-skip branch. Other debug
    // lines may exist in the future — filter by the expected msg.
    const debugEntries = logSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          !!entry &&
          entry.level === "debug" &&
          typeof entry.msg === "string" &&
          (entry.msg as string).includes("stale"),
      );

    expect(debugEntries.length).toBeGreaterThanOrEqual(1);
    const entry = debugEntries[0]!;
    expect(entry.startedAtGen).toBe(0);
    expect(entry.currentGen).toBe(1);

    logSpy.mockRestore();
  });
});
