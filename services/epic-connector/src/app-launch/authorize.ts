/**
 * Authorize-URL builder for SMART App Launch (#392).
 *
 * Constructs the URL we redirect the user's browser to when they begin
 * either an EHR Launch (Epic clicks "open CareBridge" → we get a
 * `launch` token + `iss`) or a Standalone Launch (clinician opens
 * CareBridge first → we discover Epic's authorize URL via
 * .well-known/smart-configuration).
 *
 * Spec: https://build.fhir.org/ig/HL7/smart-app-launch/app-launch.html
 *
 * Required params:
 *   response_type=code
 *   client_id=<our Epic-registered client id>
 *   redirect_uri=<our callback URL — must EXACTLY match what's
 *                 registered at open.epic.com>
 *   scope=<requested SMART scopes>
 *   state=<opaque CSRF token; we use the OAuth state to key our
 *          server-side launch-state row>
 *   aud=<iss FHIR base — protects against confused-deputy attacks
 *        where a different EHR's authorize endpoint reuses our code>
 *   code_challenge=<S256-hashed PKCE challenge>
 *   code_challenge_method=S256
 *
 * EHR-launch additions:
 *   launch=<the launch token Epic gave us in the bootstrap redirect>
 */
export interface AuthorizeUrlArgs {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  /** FHIR base URL — also the OAuth `aud` claim. Required by SMART. */
  aud: string;
  codeChallenge: string;
  /** Present on EHR Launch; omit for Standalone. */
  launch?: string;
}

/**
 * Default scope set we request for a user-context Epic launch.
 *
 * - launch                — required for EHR Launch (no-op on Standalone)
 * - openid + fhirUser     — we need an id_token with the Practitioner FHIR id
 * - offline_access        — request a refresh token so the session
 *                           survives access-token expiry without
 *                           re-launching from Epic
 * - patient/*.read        — read-only access to the launch-context
 *                           patient
 * - user/Practitioner.read — read the practitioner identity behind
 *                           the launch so we can match them to the
 *                           CareBridge user.
 */
export const DEFAULT_APP_LAUNCH_SCOPES = [
  "launch",
  "openid",
  "fhirUser",
  "offline_access",
  "patient/*.read",
  "user/Practitioner.read",
] as const;

export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const url = new URL(args.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scopes.join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("aud", args.aud);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.launch) {
    url.searchParams.set("launch", args.launch);
  }
  return url.toString();
}
