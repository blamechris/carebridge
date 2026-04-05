/**
 * Cryptographic password hashing using Node.js built-in scrypt.
 *
 * Format: scrypt:N=16384,r=8,p=1:<hex-salt>:<hex-derived-key>
 *
 * scrypt is a memory-hard KDF (Key Derivation Function) that is
 * resistant to GPU/ASIC brute-force attacks. Parameters:
 *   N=16384 — CPU/memory cost (2^14 iterations)
 *   r=8     — block size factor
 *   p=1     — parallelization factor
 *
 * This meets NIST SP 800-132 guidance for password-based key derivation
 * and satisfies HIPAA §164.308(a)(5)(ii)(D) password management requirements.
 */

import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

const SALT_BYTES = 32;
const KEY_BYTES = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const PARAMS_STR = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
const PREFIX = "scrypt";

/**
 * Hash a plaintext password. Returns a formatted string safe to store in the DB.
 * This is an async operation — do not block the event loop.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = (await scryptAsync(
    password,
    salt,
    KEY_BYTES,
    SCRYPT_PARAMS,
  )) as Buffer;
  return `${PREFIX}:${PARAMS_STR}:${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Uses timing-safe comparison to prevent timing oracle attacks.
 *
 * Returns false (not throws) for any malformed hash, which handles
 * the dev-mode `hashed:` prefix gracefully by rejecting it.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (!storedHash.startsWith(`${PREFIX}:`)) {
    // Not a scrypt hash (e.g. old dev placeholder) — reject it
    return false;
  }

  const parts = storedHash.split(":");
  if (parts.length !== 4) {
    return false;
  }

  const [, , salt, storedKeyHex] = parts;

  try {
    const derivedKey = (await scryptAsync(
      password,
      salt!,
      KEY_BYTES,
      SCRYPT_PARAMS,
    )) as Buffer;
    const storedKey = Buffer.from(storedKeyHex!, "hex");

    if (derivedKey.length !== storedKey.length) {
      return false;
    }

    // Timing-safe comparison — critical to prevent timing attacks
    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch {
    return false;
  }
}

/**
 * Check if a stored hash was created with the current parameters.
 * Used to detect hashes that need to be upgraded.
 */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith(`${PREFIX}:${PARAMS_STR}:`);
}
