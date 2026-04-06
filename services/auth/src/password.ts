/**
 * Password hashing and verification using Node.js scrypt.
 *
 * Each hash includes a random salt so identical passwords produce different
 * hashes. Verification uses timingSafeEqual to prevent timing attacks.
 */

import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p

/**
 * Hash a password using scrypt with a random 16-byte salt.
 * Returns a string in the format: scrypt:<salt_hex>:<hash_hex>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);

  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`);
      },
    );
  });
}

/**
 * Verify a password against a stored hash.
 * Only accepts scrypt-format hashes. Rejects legacy "hashed:" prefix format.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  // Reject legacy dev-mode format
  if (storedHash.startsWith("hashed:")) {
    return false;
  }

  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const salt = Buffer.from(parts[1]!, "hex");
  const expectedKey = Buffer.from(parts[2]!, "hex");

  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (err, derivedKey) => {
        if (err) return reject(err);
        try {
          resolve(crypto.timingSafeEqual(derivedKey, expectedKey));
        } catch {
          resolve(false);
        }
      },
    );
  });
}
