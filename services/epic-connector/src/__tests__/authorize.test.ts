/**
 * Authorize-URL builder tests (#392).
 */
import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  DEFAULT_APP_LAUNCH_SCOPES,
} from "../app-launch/authorize.js";

const baseArgs = {
  authorizeUrl: "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize",
  clientId: "carebridge-client",
  redirectUri: "https://app.carebridge.test/auth/epic/callback",
  scopes: [...DEFAULT_APP_LAUNCH_SCOPES],
  state: "opaque-state-1234",
  aud: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/",
  codeChallenge: "challenge-abcdef",
};

describe("buildAuthorizeUrl (#392)", () => {
  it("includes every required SMART App Launch param", () => {
    const url = new URL(buildAuthorizeUrl(baseArgs));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("carebridge-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.carebridge.test/auth/epic/callback",
    );
    expect(url.searchParams.get("state")).toBe("opaque-state-1234");
    expect(url.searchParams.get("aud")).toBe(baseArgs.aud);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abcdef");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("space-joins the scope list per OAuth 2 standard", () => {
    const url = new URL(buildAuthorizeUrl(baseArgs));
    expect(url.searchParams.get("scope")).toBe(
      "launch openid fhirUser offline_access patient/*.read user/Practitioner.read",
    );
  });

  it("omits `launch` param when launch token is absent (Standalone Launch)", () => {
    const url = new URL(buildAuthorizeUrl(baseArgs));
    expect(url.searchParams.has("launch")).toBe(false);
  });

  it("includes `launch` param when token is provided (EHR Launch)", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...baseArgs, launch: "ehr-launch-token-xyz" }),
    );
    expect(url.searchParams.get("launch")).toBe("ehr-launch-token-xyz");
  });

  it("targets the authorize endpoint passed in (not a hardcoded URL)", () => {
    const customAuthorize = "https://fhir.example-hospital.org/oauth/auth";
    const url = new URL(
      buildAuthorizeUrl({ ...baseArgs, authorizeUrl: customAuthorize }),
    );
    expect(url.origin + url.pathname).toBe(customAuthorize);
  });
});
