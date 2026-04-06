import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import crypto from "node:crypto";

// ── Secret key ─────────────────────────────────────────────────────────────

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw) {
    throw new Error("JWT_SECRET environment variable is not set.");
  }
  // Accept any non-empty string; SHA-256 normalises it to a consistent 32-byte key.
  return crypto.createHash("sha256").update(raw).digest();
}

// ── Public types ───────────────────────────────────────────────────────────

export interface JWTPayload {
  /** Subject — user ID */
  sub: string;
  /** Session ID — the opaque UUID stored in the sessions table */
  sid: string;
  /** Issued-at (Unix seconds) */
  iat: number;
  /** Expiry (Unix seconds) */
  exp: number;
}

// ── Error classes ──────────────────────────────────────────────────────────

export class JWTError extends Error {}
export class JWTExpiredError extends JWTError {}

// ── Sign ───────────────────────────────────────────────────────────────────

/**
 * Sign a JWT with HS256 using the JWT_SECRET environment variable.
 * Returns a compact serialised token: `header.payload.signature`.
 */
export async function signJWT(payload: JWTPayload): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ sid: payload.sid } as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(secret);
}

// ── Verify ─────────────────────────────────────────────────────────────────

/**
 * Verify and decode a JWT.
 *
 * Throws `JWTExpiredError` when the token is valid but past its `exp` claim,
 * and `JWTError` for all other validation failures.
 */
export async function verifyJWT(token: string): Promise<JWTPayload> {
  const secret = getSecret();

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    if (typeof payload.sid !== "string") {
      throw new JWTError("JWT missing required claims");
    }

    return {
      sub: payload.sub as string,
      sid: payload.sid as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch (err) {
    if (err instanceof JWTError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new JWTExpiredError("JWT expired");
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new JWTError("Invalid JWT signature");
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      throw new JWTError("JWT claim validation failed");
    }
    throw new JWTError(err instanceof Error ? err.message : "Malformed JWT");
  }
}
