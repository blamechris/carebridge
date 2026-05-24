/**
 * Epic SMART Backend Services token client (#389).
 *
 * Exchanges a client_assertion JWT for an OAuth 2.0 access token at
 * Epic's token endpoint, caching the result until shortly before expiry.
 *
 * Spec: https://build.fhir.org/ig/HL7/smart-app-launch/backend-services.html
 *
 * Request shape (form-encoded):
 *   grant_type=client_credentials
 *   client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
 *   client_assertion=<RS384-signed JWT>
 *   scope=<space-separated SMART scopes>
 *
 * Response: { access_token, expires_in, token_type, scope }
 */
import { createLogger } from "@carebridge/logger";
import { buildClientAssertion } from "./jwt-assertion.js";
import type { EpicConfig } from "./config.js";

const log = createLogger("epic-token-client");

/**
 * Default SMART Backend Services scopes (Epic-supported subset).
 * Callers can override by passing `scopes` to {@link getAccessToken}.
 */
export const DEFAULT_SYSTEM_SCOPES = [
  "system/Patient.read",
  "system/Observation.read",
  "system/Condition.read",
  "system/MedicationRequest.read",
  "system/AllergyIntolerance.read",
  "system/Encounter.read",
];

/**
 * Refresh-buffer window (seconds). When the cached token's remaining
 * lifetime drops below this, the next call requests a fresh one. 60s
 * is comfortably longer than the worst-case network RTT and Epic's
 * documented token-issue latency.
 */
const REFRESH_BUFFER_SEC = 60;

export interface TokenResponse {
  /** Bearer access token to send as Authorization: Bearer <token>. */
  access_token: string;
  /** Seconds until expiry from issue time. Epic typically returns 3600. */
  expires_in: number;
  /** Always "Bearer" for SMART Backend Services. */
  token_type: string;
  /** Granted scopes (space-separated); may be a subset of what was requested. */
  scope: string;
}

interface CachedToken {
  response: TokenResponse;
  /** Absolute wall-clock time the token expires (ms). */
  expiresAtMs: number;
}

/**
 * Stateful token client. Holds the cached token and the config.
 * One instance per Epic tenant; multi-tenant deployments instantiate
 * separately per (clientId, tokenUrl) pair.
 */
export class EpicTokenClient {
  private cached: CachedToken | null = null;
  /**
   * In-flight token request. Concurrent {@link getAccessToken} callers
   * that arrive while a fetch is outstanding await the same promise
   * instead of each kicking off their own request (#1089). Cleared as
   * soon as the request settles (success or failure) so the cache /
   * retry path takes over for subsequent callers.
   */
  private inFlight: Promise<TokenResponse> | null = null;

  constructor(
    private readonly config: EpicConfig,
    /** Override for tests; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Override for tests; defaults to Date.now. */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Return a usable access token. Uses the cached value when it has
   * more than REFRESH_BUFFER_SEC of lifetime left; otherwise requests
   * a fresh one. Concurrent callers that arrive while a fetch is
   * outstanding coalesce on a shared in-flight promise (#1089) so a
   * burst of N callers issues a single network round-trip.
   */
  async getAccessToken(scopes: string[] = DEFAULT_SYSTEM_SCOPES): Promise<string> {
    if (this.cached) {
      const remainingMs = this.cached.expiresAtMs - this.nowMs();
      if (remainingMs > REFRESH_BUFFER_SEC * 1000) {
        return this.cached.response.access_token;
      }
    }

    // If a refresh is already in flight, every concurrent caller awaits
    // the same promise. The first caller to enter this branch sets
    // `inFlight`; later callers in the same tick observe it and join.
    if (this.inFlight) {
      const parsed = await this.inFlight;
      return parsed.access_token;
    }

    const issuedAtMs = this.nowMs();
    this.inFlight = this.fetchToken(scopes, issuedAtMs);
    try {
      const parsed = await this.inFlight;
      return parsed.access_token;
    } finally {
      // Always clear the in-flight slot — whether the fetch resolved or
      // rejected — so the next caller observes a clean state. On
      // failure the cache is untouched (no `this.cached` write) and the
      // next call will issue its own retry; on success the cache has
      // been populated and the next call is served from it.
      this.inFlight = null;
    }
  }

  /**
   * Internal fetch helper. Extracted so the in-flight slot can be
   * tracked as a single `Promise<TokenResponse>` regardless of the
   * scope override or issued-at timestamp.
   */
  private async fetchToken(
    scopes: string[],
    issuedAtMs: number,
  ): Promise<TokenResponse> {
    const assertion = buildClientAssertion({
      clientId: this.config.clientId,
      tokenUrl: this.config.tokenUrl,
      kid: this.config.jwtKid,
      privateKeyPem: this.config.privateKeyPem,
      now: () => Math.floor(issuedAtMs / 1000),
    });

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: scopes.join(" "),
    });

    const response = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      // Epic returns OAuth 2.0 error payloads as JSON with `error` /
      // `error_description` fields. Parse those out and log ONLY the
      // structured fields — never the raw body, which may echo back the
      // client_assertion JWT (a credential that, if leaked to log
      // collectors, can be replayed against Epic for the assertion's
      // lifetime).
      const errorFields = parseOAuthError(text);
      log.warn("Epic token request failed", {
        status: response.status,
        statusText: response.statusText,
        oauth_error: errorFields.error,
        oauth_error_description: errorFields.error_description,
      });
      throw new Error(
        `Epic token endpoint returned ${response.status} ${response.statusText}`,
      );
    }

    const parsed = (await response.json()) as TokenResponse;
    this.cached = {
      response: parsed,
      expiresAtMs: issuedAtMs + parsed.expires_in * 1000,
    };
    return parsed;
  }

  /**
   * Drop the cached token AND any in-flight refresh promise. Forces
   * the next {@link getAccessToken} call to request a fresh one.
   * Useful when the FHIR client receives a 401 (token revoked / org
   * rotated keys) and wants to retry once with a fresh assertion
   * before failing. Clearing the in-flight reference too (#1089)
   * prevents a stale-credential refresh from satisfying the retry.
   */
  invalidate(): void {
    this.cached = null;
    this.inFlight = null;
  }
}

/**
 * Best-effort parser for OAuth 2.0 error responses (RFC 6749 §5.2).
 * Returns the structured `error` + `error_description` fields when the
 * body is JSON; falls back to undefined when it isn't (so the caller
 * doesn't accidentally log opaque token endpoint output).
 */
function parseOAuthError(body: string): {
  error?: string;
  error_description?: string;
} {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      error_description:
        typeof parsed.error_description === "string"
          ? parsed.error_description
          : undefined,
    };
  } catch {
    return {};
  }
}
