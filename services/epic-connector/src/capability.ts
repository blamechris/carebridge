/**
 * SMART configuration discovery (#389).
 *
 * Per the SMART App Launch spec §Discovery, a FHIR server publishes a
 * JSON document at `/.well-known/smart-configuration` describing its
 * OAuth2 endpoints, supported scopes, and capabilities.
 *
 * Used at startup to resolve the token endpoint when it isn't pinned in
 * config, and to confirm the server advertises `client-credentials`
 * grant support before we attempt a backend-services token exchange.
 *
 * Spec: https://build.fhir.org/ig/HL7/smart-app-launch/conformance.html#smart-configuration
 */
import { createLogger } from "@carebridge/logger";

const log = createLogger("epic-capability");

export interface SmartConfiguration {
  /** OAuth2 token endpoint — what the assertion's `aud` claim binds to. */
  token_endpoint: string;
  /** OAuth2 authorisation endpoint (used by SMART App Launch, not Backend Services). */
  authorization_endpoint?: string;
  /** JWKS URI Epic uses to validate the assertion's signature. */
  jwks_uri?: string;
  /** Capabilities advertised by the server (e.g. "client-confidential-asymmetric"). */
  capabilities?: string[];
  /** Grant types supported (we require "client_credentials"). */
  grant_types_supported?: string[];
  /** Scopes supported (subset of what we request). */
  scopes_supported?: string[];
}

/**
 * Build the well-known URL for the given FHIR base URL. Per SMART App
 * Launch §Discovery, the conformance document MAY be served from the
 * FHIR base or from the server root — Epic's interconnect deployments
 * serve it from the FHIR base, so we keep the path intact and just
 * append `.well-known/smart-configuration`. Hosts that require root-
 * level discovery can pass the root URL directly.
 */
export function smartConfigurationUrl(fhirBaseUrl: string): string {
  const trimmed = fhirBaseUrl.replace(/\/+$/, "");
  return `${trimmed}/.well-known/smart-configuration`;
}

/**
 * Fetch and parse the SMART configuration. Throws on network failure,
 * non-2xx response, or malformed JSON. Callers should cache the result
 * — these documents change rarely and a refetch per token request is
 * wasted network.
 */
export async function fetchSmartConfiguration(
  fhirBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartConfiguration> {
  const url = smartConfigurationUrl(fhirBaseUrl);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `SMART configuration discovery failed: ${response.status} ${response.statusText} at ${url}`,
    );
  }
  const parsed = (await response.json()) as SmartConfiguration;
  if (!parsed.token_endpoint) {
    throw new Error(
      `SMART configuration at ${url} is missing token_endpoint`,
    );
  }
  if (
    parsed.grant_types_supported &&
    !parsed.grant_types_supported.includes("client_credentials")
  ) {
    log.warn(
      "SMART configuration does not advertise client_credentials grant",
      { url, grants: parsed.grant_types_supported },
    );
  }
  return parsed;
}
