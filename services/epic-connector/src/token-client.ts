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
  /**
   * Per-scope cached tokens (#1144). Keyed by a normalized (sorted,
   * space-joined) scopes string so concurrent callers asking for
   * different scope sets never share a cache entry — otherwise a
   * caller that requested ["system/Patient.read", "system/Observation.read"]
   * could be served a narrower token cached from an earlier
   * single-scope fetch and then fail mid-call when reading an
   * Observation. Sorting before join means ["a","b"] and ["b","a"]
   * map to the same key.
   */
  private cached: Map<string, CachedToken> = new Map();
  /**
   * Per-scope in-flight token requests (#1144). Keyed the same way as
   * {@link cached}: concurrent callers asking for the same scope set
   * (in any order) coalesce on a shared promise (#1089); callers
   * asking for a DIFFERENT scope set each get their own fetch and
   * their own correctly-scoped token. Cleared as soon as each request
   * settles (success or failure) so the cache / retry path takes over
   * for subsequent callers.
   */
  private inFlight: Map<string, Promise<TokenResponse>> = new Map();
  /**
   * Monotonic generation counter (#1143). Incremented every time
   * {@link invalidate} is called so any fetch already running when
   * invalidate() fired can tell that its result is stale and must NOT
   * overwrite the cache (which a successful retry may have already
   * populated with a fresh token). Each fetch captures the generation
   * it was started under and only writes back to `cached` / `inFlight`
   * if that generation is still current. With per-scope keying (#1144)
   * the generation guard still operates globally — bumping it on
   * invalidate() invalidates EVERY in-flight fetch across every scope
   * key, which is correct since invalidate() clears all entries.
   */
  private generation = 0;

  constructor(
    private readonly config: EpicConfig,
    /** Override for tests; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Override for tests; defaults to Date.now. */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Normalize a scope set to a stable cache key. Sorting before join
   * means callers passing the same scopes in different orders share a
   * single cache + in-flight slot (#1144). Empty arrays produce an
   * empty string, which is a valid Map key distinct from any non-empty
   * scope set — matching pre-existing behaviour that passes the empty
   * string through as the `scope` form field.
   */
  private normalizeScopes(scopes: readonly string[]): string {
    return [...scopes].sort().join(" ");
  }

  /**
   * Return a usable access token. Uses the cached value when it has
   * more than REFRESH_BUFFER_SEC of lifetime left; otherwise requests
   * a fresh one. Concurrent callers that arrive while a fetch is
   * outstanding AND requested the same scope set coalesce on a shared
   * in-flight promise (#1089, #1144) so a burst of N same-scope
   * callers issues a single network round-trip. Concurrent callers
   * with DIFFERENT scope sets each get their own correctly-scoped
   * fetch — coalescing across scope sets would silently hand a caller
   * a token missing scopes it explicitly asked for.
   */
  async getAccessToken(scopes: string[] = DEFAULT_SYSTEM_SCOPES): Promise<string> {
    const key = this.normalizeScopes(scopes);

    const cachedEntry = this.cached.get(key);
    if (cachedEntry) {
      const remainingMs = cachedEntry.expiresAtMs - this.nowMs();
      if (remainingMs > REFRESH_BUFFER_SEC * 1000) {
        return cachedEntry.response.access_token;
      }
    }

    // If a refresh is already in flight for THIS scope key, every
    // concurrent caller asking for the same scopes awaits the same
    // promise. Different-scope callers fall through to start their own
    // fetch below.
    const existingInFlight = this.inFlight.get(key);
    if (existingInFlight) {
      const parsed = await existingInFlight;
      return parsed.access_token;
    }

    const issuedAtMs = this.nowMs();
    // Capture the generation BEFORE kicking off the fetch (#1143). If
    // invalidate() fires while we're awaiting, `this.generation` will
    // have advanced; fetchToken() checks that and refuses to write
    // back stale results to either the cache or the in-flight slot.
    const myGen = this.generation;
    const pending = this.fetchToken(scopes, issuedAtMs, myGen, key);
    this.inFlight.set(key, pending);
    try {
      const parsed = await pending;
      return parsed.access_token;
    } finally {
      // Only clear the in-flight slot if it's still ours. If
      // invalidate() ran while we were awaiting, the slot has already
      // been cleared (or a newer fetch from the same generation has
      // populated it) and we must not stomp on the newer state.
      if (this.generation === myGen && this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Internal fetch helper. Extracted so the in-flight slot can be
   * tracked as a single `Promise<TokenResponse>` regardless of the
   * scope override or issued-at timestamp. The `key` argument is the
   * pre-computed normalized scope key (#1144) used to write the
   * cache entry on success.
   */
  private async fetchToken(
    scopes: string[],
    issuedAtMs: number,
    startedAtGen: number,
    key: string,
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
    // Only write back to the cache if our generation is still current
    // (#1143). If invalidate() fired while we were awaiting fetch /
    // response.json(), our result is stale — a subsequent retry may
    // already have populated `cached` with a fresh token for THIS
    // scope key (#1144) and we must not stomp on it. Per-key writes
    // also mean a late, stale wide-scope fetch cannot pollute the
    // unrelated narrow-scope cache entry.
    if (this.generation === startedAtGen) {
      this.cached.set(key, {
        response: parsed,
        expiresAtMs: issuedAtMs + parsed.expires_in * 1000,
      });
    }
    return parsed;
  }

  /**
   * Drop ALL cached tokens (every scope key) AND every in-flight
   * refresh promise. Forces the next {@link getAccessToken} call to
   * request a fresh one regardless of which scope set it asks for.
   * Useful when the FHIR client receives a 401 (token revoked / org
   * rotated keys) and wants to retry once with a fresh assertion
   * before failing. Clearing the in-flight references too (#1089)
   * prevents a stale-credential refresh from satisfying the retry,
   * and clearing across every scope key (#1144) prevents a different-
   * scope cache entry from outliving a credential rotation.
   */
  invalidate(): void {
    this.cached.clear();
    this.inFlight.clear();
    // Bump the generation so any fetch that is already in flight when
    // invalidate() fires will see `this.generation !== startedAtGen`
    // when it tries to write its result back. That prevents the dropped
    // promise from overwriting a fresh token that a subsequent retry
    // may have already cached (#1143). The generation is global, not
    // per-scope-key — invalidate() really does invalidate every
    // outstanding fetch across every scope set.
    this.generation += 1;
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
