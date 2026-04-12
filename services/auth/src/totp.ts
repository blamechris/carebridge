import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

// ---------- TOTP (via otpauth library) ----------

/**
 * Generate a random 20-byte base32-encoded secret.
 */
export function generateSecret(): string {
  const secret = new OTPAuth.Secret({ size: 20 });
  return secret.base32;
}

/**
 * Generate a TOTP code per RFC 6238 (HMAC-SHA1, 6 digits, 30s period).
 */
export function generateTOTP(secret: string, time?: number): string {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  if (time !== undefined) {
    // otpauth.generate accepts a timestamp option
    return totp.generate({ timestamp: time * 1000 });
  }

  return totp.generate();
}

/**
 * Verify a TOTP code with a configurable window (default: +/- 1 time step).
 */
export function verifyTOTP(
  secret: string,
  token: string,
  window: number = 1,
): boolean {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  const delta = totp.validate({ token, window });
  return delta !== null;
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

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- OTP Auth URI ----------

/**
 * Build an otpauth:// URI for QR code generation.
 */
export function buildOTPAuthURI(secret: string, email: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "CareBridge",
    label: email,
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  return totp.toString();
}

/**
 * Render an otpauth:// URI as a PNG data URL (`data:image/png;base64,...`)
 * using a local, no-network QR code library.
 *
 * This exists because the TOTP shared secret is embedded in the otpauth URI,
 * so it MUST NOT be sent to any third-party QR service (e.g. api.qrserver.com
 * or chart.googleapis.com). See issue #280.
 */
export async function buildOTPAuthQRCode(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    type: "image/png",
    margin: 2,
    width: 240,
  });
}
