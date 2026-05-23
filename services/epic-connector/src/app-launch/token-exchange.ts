/**
 * SMART App Launch authorization-code → token exchange (#392).
 *
 * Posts to Epic's token endpoint with the authorization code, redirect
 * URI (must match what was sent on the authorize step), client_id, and
 * PKCE code_verifier. Returns the parsed token response including
 * id_token and the EHR-launch context fields (`patient`, `encounter`).
 *
 * No client_secret — Epic public-client App Launch is PKCE-only.
 *
 * Spec: https://build.fhir.org/ig/HL7/smart-app-launch/app-launch.html#token-response
 */
import { createLogger } from "@carebridge/logger";

const log = createLogger("epic-app-launch-token");

export interface ExchangeArgs {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Subset of the token response that callers consume. Epic emits
 * additional fields (`refresh_token_expires_in`, `need_patient_banner`,
 * etc.) — passthrough JSON in {@link extra} preserves them so we don't
 * have to revisit this file every time Epic adds a field.
 */
export interface AppLaunchTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until expiry, from issue time. */
  expires_in: number;
  /** Granted scopes (space-separated; may be a subset of requested). */
  scope: string;
  /**
   * OpenID Connect id_token. Decoded by the caller; we don't sign-verify
   * here because Epic's JWKS rotation cadence is out of scope for the
   * App-Launch unit. Signature verification is best-effort delegated to
   * the OAuth-callback handler.
   */
  id_token?: string;
  /** Refresh token (only when `offline_access` was granted). */
  refresh_token?: string;
  /** EHR-launch patient context (FHIR Patient.id). Absent for Standalone. */
  patient?: string;
  /** EHR-launch encounter context (FHIR Encounter.id). Often absent. */
  encounter?: string;
  /** Raw passthrough for fields we don't model. */
  extra: Record<string, unknown>;
}

export async function exchangeAuthorizationCode(
  args: ExchangeArgs,
): Promise<AppLaunchTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });

  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(args.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await safeReadBody(response);
    log.warn("Epic App Launch token exchange failed", {
      status: response.status,
      bodyPrefix: text.slice(0, 200),
    });
    throw new Error(
      `Epic token endpoint returned ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;

  // Type-narrow each field we expose. Unknown extras stay in `extra`
  // for callers that need them (need_patient_banner, smart_style_url
  // for embedded launch UI theming, etc).
  const known = new Set([
    "access_token",
    "token_type",
    "expires_in",
    "scope",
    "id_token",
    "refresh_token",
    "patient",
    "encounter",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    if (!known.has(k)) extra[k] = v;
  }

  return {
    access_token: String(json.access_token ?? ""),
    token_type: String(json.token_type ?? "Bearer"),
    expires_in: Number(json.expires_in ?? 0),
    scope: String(json.scope ?? ""),
    id_token: optString(json.id_token),
    refresh_token: optString(json.refresh_token),
    patient: optString(json.patient),
    encounter: optString(json.encounter),
    extra,
  };
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Decode the JWS payload of an id_token without verifying the signature.
 * Use only when:
 *   - The token was just returned over TLS by the issuer's token endpoint
 *     (we trust the source, not the token in isolation)
 *   - The caller logs the issuer mismatch / kid lookup separately
 * For long-term acceptance of an id_token (e.g. as a session anchor),
 * use a JWKS verifier instead.
 */
export function decodeIdTokenUnsafe(
  idToken: string,
): { sub?: string; fhirUser?: string; iss?: string; aud?: string } | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadBase64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadBase64.padEnd(
      payloadBase64.length + ((4 - (payloadBase64.length % 4)) % 4),
      "=",
    );
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded) as {
      sub?: string;
      fhirUser?: string;
      iss?: string;
      aud?: string;
    };
  } catch {
    return null;
  }
}

/**
 * Extract the Practitioner FHIR id from the `fhirUser` claim.
 * The claim's value is a URL like `https://fhir.epic.com/.../Practitioner/abc-123`.
 * Returns just `abc-123`, or null if the claim doesn't reference a Practitioner.
 */
export function extractPractitionerId(fhirUser: string | undefined): string | null {
  if (!fhirUser) return null;
  const m = fhirUser.match(/\/Practitioner\/([^/?#]+)$/);
  return m ? m[1]! : null;
}
