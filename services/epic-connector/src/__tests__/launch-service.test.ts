/**
 * End-to-end (offline) tests for the App Launch orchestrator (#392).
 *
 * The orchestrator wires together discovery → PKCE → authorize URL →
 * state store → token exchange → connection upsert. Each step is
 * tested in isolation elsewhere; here we verify the glue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the connection-repo so we don't touch Postgres ──────────
const upsertEpicConnection = vi.fn().mockResolvedValue("conn-1");
vi.mock("../app-launch/connection-repo.js", () => ({
  upsertEpicConnection,
  getConnectionsForUser: vi.fn(),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
}));

const { beginLaunch, completeLaunch } = await import(
  "../app-launch/launch-service.js"
);
const { InMemoryLaunchStateStore } = await import(
  "../app-launch/state-store.js"
);

function smartConfigResponse(extras: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      token_endpoint:
        "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
      authorization_endpoint:
        "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize",
      grant_types_supported: ["authorization_code", "client_credentials"],
      ...extras,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function tokenExchangeResponse(extras: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "epic-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "patient/*.read openid fhirUser launch",
      refresh_token: "epic-refresh-token",
      patient: "epic-patient-1",
      ...extras,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const ISS = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/";
const REDIRECT_URI = "https://app.carebridge.test/auth/epic/callback";
const CLIENT_ID = "carebridge-client";
const USER_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("beginLaunch → completeLaunch (#392)", () => {
  it("EHR Launch happy path: state persists, authorize URL has launch param", async () => {
    const fetchMock = vi.fn().mockResolvedValue(smartConfigResponse());
    const store = new InMemoryLaunchStateStore();

    const { authorizeUrl, state } = await beginLaunch(
      {
        iss: ISS,
        launch: "ehr-launch-token",
        userId: USER_ID,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        postLaunchRedirect: "/patients/abc",
        fetchImpl: fetchMock,
      },
      store,
    );

    expect(state.length).toBeGreaterThan(20);
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("launch")).toBe("ehr-launch-token");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("aud")).toBe(ISS);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const persisted = await store.get(state);
    expect(persisted?.userId).toBe(USER_ID);
    expect(persisted?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(persisted?.launchToken).toBe("ehr-launch-token");
  });

  it("Standalone Launch strips 'launch' scope so Epic doesn't reject it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(smartConfigResponse());
    const store = new InMemoryLaunchStateStore();

    const { authorizeUrl } = await beginLaunch(
      {
        iss: ISS,
        // no launch token — Standalone
        userId: USER_ID,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        postLaunchRedirect: "/",
        fetchImpl: fetchMock,
      },
      store,
    );

    const url = new URL(authorizeUrl);
    expect(url.searchParams.has("launch")).toBe(false);
    expect(url.searchParams.get("scope")).not.toContain(" launch ");
    expect(url.searchParams.get("scope")).not.toMatch(/^launch /);
  });

  it("completeLaunch exchanges code, decodes practitioner from id_token, upserts the connection", async () => {
    // Build an id_token with a Practitioner FHIR reference
    const idPayload = Buffer.from(
      JSON.stringify({
        sub: "epic-user-1",
        fhirUser:
          "https://fhir.epic.com/api/FHIR/R4/Practitioner/practitioner-xyz",
      }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const fakeIdToken = `header.${idPayload}.sig`;

    // First fetch = SMART discovery (during beginLaunch);
    // second fetch = token exchange (during completeLaunch)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(smartConfigResponse())
      .mockResolvedValueOnce(
        tokenExchangeResponse({ id_token: fakeIdToken }),
      );

    const store = new InMemoryLaunchStateStore();

    const { state } = await beginLaunch(
      {
        iss: ISS,
        launch: "ehr-launch-token",
        userId: USER_ID,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        postLaunchRedirect: "/patients/from-epic",
        fetchImpl: fetchMock,
      },
      store,
    );

    const result = await completeLaunch(
      {
        state,
        code: "epic-auth-code",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        fetchImpl: fetchMock,
      },
      store,
    );

    expect(result.connectionId).toBe("conn-1");
    expect(result.patientFhirId).toBe("epic-patient-1");
    expect(result.practitionerFhirId).toBe("practitioner-xyz");
    expect(result.postLaunchRedirect).toBe("/patients/from-epic");

    expect(upsertEpicConnection).toHaveBeenCalledOnce();
    const upsertArgs = upsertEpicConnection.mock.calls[0]![0];
    expect(upsertArgs.user_id).toBe(USER_ID);
    expect(upsertArgs.access_token).toBe("epic-access-token");
    expect(upsertArgs.refresh_token).toBe("epic-refresh-token");
    expect(upsertArgs.epic_practitioner_fhir_id).toBe("practitioner-xyz");
    expect(upsertArgs.epic_patient_fhir_id).toBe("epic-patient-1");
    expect(upsertArgs.id_token_subject).toBe("epic-user-1");
  });

  it("state is single-use — a replay attempt errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(smartConfigResponse())
      .mockResolvedValueOnce(tokenExchangeResponse())
      .mockResolvedValueOnce(tokenExchangeResponse());

    const store = new InMemoryLaunchStateStore();
    const { state } = await beginLaunch(
      {
        iss: ISS,
        launch: "ehr-launch-token",
        userId: USER_ID,
        redirectUri: REDIRECT_URI,
        clientId: CLIENT_ID,
        postLaunchRedirect: "/",
        fetchImpl: fetchMock,
      },
      store,
    );

    await completeLaunch(
      {
        state,
        code: "code-1",
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        fetchImpl: fetchMock,
      },
      store,
    );

    // Replay with same state — should fail because state was consumed
    await expect(
      completeLaunch(
        {
          state,
          code: "code-2",
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          fetchImpl: fetchMock,
        },
        store,
      ),
    ).rejects.toThrow(/state expired or unknown/);
  });

  it("rejects unknown / expired state", async () => {
    const store = new InMemoryLaunchStateStore();
    await expect(
      completeLaunch(
        {
          state: "never-issued",
          code: "x",
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
        },
        store,
      ),
    ).rejects.toThrow(/state expired or unknown/);
  });

  it("InMemoryLaunchStateStore expires entries past their TTL", async () => {
    let now = 1_000_000_000_000;
    const store = new InMemoryLaunchStateStore(() => now);
    await store.set(
      "abc",
      {
        codeVerifier: "v",
        iss: ISS,
        tokenUrl: "https://t",
        authorizeUrl: "https://a",
        userId: USER_ID,
        postLaunchRedirect: "/",
        createdAt: new Date(now).toISOString(),
      },
      10, // 10s TTL
    );
    expect(await store.get("abc")).not.toBeNull();
    now += 11_000; // 11s later — past TTL
    expect(await store.get("abc")).toBeNull();
  });
});
