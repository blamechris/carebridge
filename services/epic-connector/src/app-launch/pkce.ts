/**
 * PKCE (RFC 7636) helpers for SMART on FHIR App Launch (#392).
 *
 * Epic's SMART App Launch flow requires PKCE — the implicit grant is
 * disallowed and bare authorization-code without `code_challenge` is
 * rejected by the authorise endpoint.
 *
 * We use the S256 challenge method (the only one Epic accepts in
 * production). The `code_verifier` is a 43-128 char URL-safe random
 * string; the `code_challenge` is BASE64URL(SHA256(verifier)).
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  /** 43-char base64url-encoded random secret. Send with token exchange. */
  codeVerifier: string;
  /** SHA-256(codeVerifier), base64url-encoded. Sent on the authorize URL. */
  codeChallenge: string;
  /** Always "S256" — Epic does not accept "plain". */
  codeChallengeMethod: "S256";
}

/**
 * Generate a fresh PKCE verifier/challenge pair. The verifier MUST be
 * persisted server-side keyed by the OAuth `state` value so the
 * callback can supply it during code exchange (the browser does not
 * see the verifier — that's the point of PKCE).
 */
export function generatePkcePair(
  rng: (size: number) => Buffer = randomBytes,
): PkcePair {
  // 32 bytes → 43 base64url characters. RFC 7636 §4.1 requires 43-128
  // characters; 43 is the minimum that still gives 256 bits of entropy
  // after the base64url encoding.
  const verifier = base64UrlEncode(rng(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Verify that a challenge derives from a verifier — used in tests
 * and in defensive checks at code-exchange time.
 */
export function verifyChallenge(verifier: string, challenge: string): boolean {
  const expected = base64UrlEncode(
    createHash("sha256").update(verifier).digest(),
  );
  return timingSafeEqual(expected, challenge);
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Length-aware constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
