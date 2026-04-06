import crypto from "node:crypto";

// ── Base64URL helpers ───────────────────────────────────────────────────────

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(str: string): Buffer {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

// ── Secret key ─────────────────────────────────────────────────────────────

function getSecret(): Buffer {
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

// ── Sign ───────────────────────────────────────────────────────────────────

const HEADER = b64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

/**
 * Sign a JWT with HS256 using the JWT_SECRET environment variable.
 * Returns a compact serialised token: `header.payload.signature`.
 */
export function signJWT(payload: JWTPayload): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sigInput = `${HEADER}.${body}`;
  const sig = b64urlEncode(
    crypto.createHmac("sha256", getSecret()).update(sigInput).digest(),
  );
  return `${sigInput}.${sig}`;
}

// ── Verify ─────────────────────────────────────────────────────────────────

export class JWTError extends Error {}
export class JWTExpiredError extends JWTError {}

/**
 * Verify and decode a JWT.
 *
 * Throws `JWTExpiredError` when the token is valid but past its `exp` claim,
 * and `JWTError` for all other validation failures.
 */
export function verifyJWT(token: string): JWTPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("Malformed JWT");

  const [header, body, sig] = parts as [string, string, string];
  const sigInput = `${header}.${body}`;

  const expected = b64urlEncode(
    crypto.createHmac("sha256", getSecret()).update(sigInput).digest(),
  );

  // Constant-time comparison to prevent timing attacks.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    throw new JWTError("Invalid JWT signature");
  }

  let payload: JWTPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as JWTPayload;
  } catch {
    throw new JWTError("Malformed JWT payload");
  }

  if (typeof payload.exp !== "number" || typeof payload.sid !== "string") {
    throw new JWTError("JWT missing required claims");
  }

  if (payload.exp * 1000 < Date.now()) {
    throw new JWTExpiredError("JWT expired");
  }

  return payload;
}
