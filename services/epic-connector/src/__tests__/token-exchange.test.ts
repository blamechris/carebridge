/**
 * App Launch token-exchange tests (#392).
 *
 * Mocks fetch so we never call Epic. Verifies request shape, response
 * parsing, error handling, and id_token decoding.
 */
import { describe, it, expect, vi } from "vitest";
import {
  exchangeAuthorizationCode,
  decodeIdTokenUnsafe,
  extractPractitionerId,
} from "../app-launch/token-exchange.js";

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "epic-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "patient/*.read user/Practitioner.read openid fhirUser",
      id_token: "header.eyJzdWIiOiJlcGljLXVzZXItMSJ9.sig",
      refresh_token: "epic-refresh-token",
      patient: "epic-patient-1",
      encounter: "epic-encounter-1",
      need_patient_banner: true,
      smart_style_url: "https://fhir.epic.com/style.json",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const baseArgs = {
  tokenUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token",
  code: "auth-code-1",
  redirectUri: "https://app.carebridge.test/auth/epic/callback",
  clientId: "carebridge-client",
  codeVerifier: "v".repeat(43),
};

describe("exchangeAuthorizationCode (#392)", () => {
  it("posts grant_type=authorization_code + code + code_verifier + redirect_uri", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    await exchangeAuthorizationCode({ ...baseArgs, fetchImpl: fetchMock });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(baseArgs.tokenUrl);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe(baseArgs.redirectUri);
    expect(body.get("client_id")).toBe("carebridge-client");
    expect(body.get("code_verifier")).toBe("v".repeat(43));
    // We're a public client (PKCE only) — no client_secret should leak.
    expect(body.get("client_secret")).toBeNull();
  });

  it("parses all the SMART App Launch fields plus passthrough extras", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    const result = await exchangeAuthorizationCode({
      ...baseArgs,
      fetchImpl: fetchMock,
    });

    expect(result.access_token).toBe("epic-access-token");
    expect(result.token_type).toBe("Bearer");
    expect(result.expires_in).toBe(3600);
    expect(result.scope).toContain("patient/*.read");
    expect(result.id_token).toBeDefined();
    expect(result.refresh_token).toBe("epic-refresh-token");
    expect(result.patient).toBe("epic-patient-1");
    expect(result.encounter).toBe("epic-encounter-1");
    expect(result.extra.need_patient_banner).toBe(true);
    expect(result.extra.smart_style_url).toBe("https://fhir.epic.com/style.json");
  });

  it("omits patient/encounter when Epic doesn't return them (Standalone Launch)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ patient: undefined, encounter: undefined }),
    );
    const result = await exchangeAuthorizationCode({
      ...baseArgs,
      fetchImpl: fetchMock,
    });
    expect(result.patient).toBeUndefined();
    expect(result.encounter).toBeUndefined();
  });

  it("throws on non-2xx responses without surfacing the body to the caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("invalid_grant: code already used", { status: 400 }),
    );
    await expect(
      exchangeAuthorizationCode({ ...baseArgs, fetchImpl: fetchMock }),
    ).rejects.toThrow(/Epic token endpoint returned 400/);
  });
});

describe("decodeIdTokenUnsafe", () => {
  it("decodes the JWS payload without verifying the signature", () => {
    // payload = { sub: "user-1", fhirUser: "Practitioner/abc-1" }
    const payload = Buffer.from(
      JSON.stringify({
        sub: "user-1",
        fhirUser: "https://fhir.epic.com/api/FHIR/R4/Practitioner/abc-1",
      }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const jwt = `header.${payload}.sig`;
    const decoded = decodeIdTokenUnsafe(jwt);
    expect(decoded?.sub).toBe("user-1");
    expect(decoded?.fhirUser).toContain("Practitioner/abc-1");
  });

  it("returns null on a malformed JWT", () => {
    expect(decodeIdTokenUnsafe("not.a.jwt-payload")).toBeNull();
    expect(decodeIdTokenUnsafe("only-one-segment")).toBeNull();
  });
});

describe("extractPractitionerId", () => {
  it("pulls the FHIR id out of a Practitioner reference URL", () => {
    expect(
      extractPractitionerId(
        "https://fhir.epic.com/interconnect/api/FHIR/R4/Practitioner/abc-123",
      ),
    ).toBe("abc-123");
  });

  it("returns null when the fhirUser claim doesn't reference a Practitioner", () => {
    expect(
      extractPractitionerId(
        "https://fhir.epic.com/api/FHIR/R4/Patient/p-1",
      ),
    ).toBeNull();
    expect(extractPractitionerId(undefined)).toBeNull();
    expect(extractPractitionerId("garbage")).toBeNull();
  });
});
