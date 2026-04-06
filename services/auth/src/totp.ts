import crypto from "node:crypto";

// ---------- Base32 encoding/decoding (RFC 4648) ----------

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >>> bits) & 0x1f]!;
    }
  }

  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f]!;
  }

  return result;
}

export function base32Decode(encoded: string): Buffer {
  const stripped = encoded.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of stripped) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

// ---------- TOTP (RFC 6238) ----------

/**
 * Generate a random 20-byte base32-encoded secret.
 */
export function generateSecret(): string {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

/**
 * Generate a TOTP code per RFC 6238 (HMAC-SHA1, 6 digits, 30s period).
 */
export function generateTOTP(secret: string, time?: number): string {
  const period = 30;
  const now = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);

  // Convert counter to 8-byte big-endian buffer
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const key = base32Decode(secret);
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();

  // Dynamic truncation per RFC 4226
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = code % 1_000_000;
  return otp.toString().padStart(6, "0");
}

/**
 * Verify a TOTP code with a configurable window (default: +/- 1 time step).
 */
export function verifyTOTP(
  secret: string,
  token: string,
  window: number = 1,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const period = 30;

  for (let i = -window; i <= window; i++) {
    const time = now + i * period;
    const expected = generateTOTP(secret, time);
    if (timingSafeEqual(token, expected)) {
      return true;
    }
  }

  return false;
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- Recovery codes ----------

/**
 * Generate a set of random recovery codes.
 */
export function generateRecoveryCodes(count: number = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 random hex chars, formatted as XXXXX-XXXXX
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * Hash a recovery code for storage.
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
}

/**
 * Verify a recovery code against a list of hashed codes.
 * Returns the index of the matched code, or -1 if not found.
 */
export function verifyRecoveryCode(
  code: string,
  hashedCodes: string[],
): number {
  const hashed = hashRecoveryCode(code);
  return hashedCodes.findIndex((h) => timingSafeEqual(hashed, h));
}

// ---------- OTP Auth URI ----------

/**
 * Build an otpauth:// URI for QR code generation.
 */
export function buildOTPAuthURI(secret: string, email: string): string {
  const issuer = "CareBridge";
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
