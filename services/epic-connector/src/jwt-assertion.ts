/**
 * RS384-signed JWT client assertion for SMART Backend Services (#389).
 *
 * Per the SMART App Launch spec §Backend Services, the client_assertion
 * is a JWT signed with the client's registered private key. Epic requires
 * RS384 (RSA + SHA-384) — NOT the default RS256 most JWT libraries use.
 *
 * Claims per the spec:
 *   iss  — client_id
 *   sub  — client_id (same value; system-to-system, no user subject)
 *   aud  — token endpoint URL (the resource the assertion authorises)
 *   exp  — issued-at + 5 min (Epic rejects anything longer)
 *   jti  — unique id (Epic rejects re-use within the exp window)
 *
 * Uses Node's crypto rather than a JWT library to keep the dependency
 * surface small and so the algorithm choice is explicit at the call site.
 */
import { createSign, randomUUID } from "node:crypto";

export interface BuildAssertionArgs {
  clientId: string;
  /** Epic token endpoint URL — the `aud` claim. */
  tokenUrl: string;
  /** Key id matching the JWK uploaded at open.epic.com. */
  kid: string;
  /** RS384 private key in PEM format. */
  privateKeyPem: string;
  /**
   * Lifetime of the assertion in seconds. Defaults to 4 minutes (240s)
   * — well under Epic's 5-minute ceiling but long enough to tolerate
   * modest clock skew between this host and Epic.
   */
  expiresInSec?: number;
  /**
   * Override `iat` / `exp` time source for tests. Defaults to Date.now().
   */
  now?: () => number;
  /**
   * Override `jti` for tests. Defaults to crypto.randomUUID().
   */
  jti?: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Build an RS384-signed JWT client assertion. Returns the compact JWS
 * (header.payload.signature) ready to plug into the
 * client_assertion form parameter of a token request.
 */
export function buildClientAssertion(args: BuildAssertionArgs): string {
  const now = args.now?.() ?? Math.floor(Date.now() / 1000);
  const expiresInSec = args.expiresInSec ?? 240;
  const jti = args.jti ?? randomUUID();

  const header = {
    alg: "RS384",
    typ: "JWT",
    kid: args.kid,
  };
  const payload = {
    iss: args.clientId,
    sub: args.clientId,
    aud: args.tokenUrl,
    exp: now + expiresInSec,
    iat: now,
    jti,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // RSA-SHA384 sign. Node's createSign("RSA-SHA384") is the explicit RS384
  // path — important because most generic crypto.sign callers default to
  // RS256 which Epic rejects.
  const signer = createSign("RSA-SHA384");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(args.privateKeyPem));

  return `${signingInput}.${signature}`;
}

/**
 * Decode the JWT header + payload without verification. Internal test
 * helper — intentionally NOT re-exported from the package entrypoint.
 * Production code never inspects its own signed JWTs; Epic does that.
 * Import from `./jwt-assertion.js` directly within tests.
 */
export function decodeAssertionForTest(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
} {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) throw new Error("malformed JWT");
  const fromB64Url = (input: string): string =>
    Buffer.from(
      input.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (input.length % 4)) % 4),
      "base64",
    ).toString("utf8");
  return {
    header: JSON.parse(fromB64Url(h)) as Record<string, unknown>,
    payload: JSON.parse(fromB64Url(p)) as Record<string, unknown>,
    signature: s,
  };
}
