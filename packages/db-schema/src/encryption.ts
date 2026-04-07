import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { customType } from "drizzle-orm/pg-core";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let _cachedKey: Buffer | null = null;
let _cachedPreviousKey: Buffer | null = null;

/** Clear cached keys. Intended for tests that swap env keys at runtime. */
export function _resetKeyCache(): void {
  _cachedKey = null;
  _cachedPreviousKey = null;
}

function parseHexKey(hex: string, label: string): Buffer {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `${label} must be exactly 32 bytes (64 hex characters), got ${buf.length} bytes.`
    );
  }
  return buf;
}

export function getKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  const hex = process.env.PHI_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "PHI_ENCRYPTION_KEY environment variable is not set. " +
        "It must be a 64-character hex string (32 bytes)."
    );
  }
  _cachedKey = parseHexKey(hex, "PHI_ENCRYPTION_KEY");
  return _cachedKey;
}

/**
 * Returns the previous encryption key for key rotation, or null if not set.
 * When PHI_ENCRYPTION_KEY_PREVIOUS is configured, decrypt will fall back to
 * this key if decryption with the current key fails (auth tag mismatch).
 */
export function getPreviousKey(): Buffer | null {
  if (_cachedPreviousKey) return _cachedPreviousKey;

  const hex = process.env.PHI_ENCRYPTION_KEY_PREVIOUS;
  if (!hex) return null;

  _cachedPreviousKey = parseHexKey(hex, "PHI_ENCRYPTION_KEY_PREVIOUS");
  return _cachedPreviousKey;
}

export function encrypt(plaintext: string, key: string | Buffer): string {
  const keyBuf = typeof key === "string" ? Buffer.from(key, "hex") : key;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(encrypted: string, key: string | Buffer): string {
  const keyBuf = typeof key === "string" ? Buffer.from(key, "hex") : key;
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format. Expected iv:authTag:ciphertext");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Decrypt with key rotation support. Tries the current key first, and if
 * decryption fails, falls back to the previous key. This allows data encrypted
 * with the old key to remain readable during a gradual re-encryption migration.
 */
export function decryptWithFallback(encrypted: string, currentKey: string | Buffer, previousKey?: string | Buffer | null): string {
  try {
    return decrypt(encrypted, currentKey);
  } catch (err) {
    if (previousKey) {
      return decrypt(encrypted, previousKey);
    }
    throw err;
  }
}

/**
 * Compute a deterministic HMAC-SHA256 of a value for use as a unique index.
 * Non-deterministic encryption (random IV) prevents the DB from enforcing
 * uniqueness on ciphertext, so we store a separate HMAC digest that is
 * stable for the same input, enabling a unique constraint in the schema.
 *
 * Uses PHI_HMAC_KEY when available; falls back to PHI_ENCRYPTION_KEY.
 * In production these should be separate keys.
 */
export function hmacForIndex(value: string): string {
  const hmacKey = process.env.PHI_HMAC_KEY;
  if (!hmacKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PHI_HMAC_KEY environment variable is required in production. " +
          "It must be a dedicated key distinct from PHI_ENCRYPTION_KEY."
      );
    }
    const fallback = process.env.PHI_ENCRYPTION_KEY;
    if (!fallback) {
      throw new Error(
        "Neither PHI_HMAC_KEY nor PHI_ENCRYPTION_KEY environment variable is set. " +
          "At least one is required to compute HMAC indexes."
      );
    }
    console.warn(
      "[encryption] PHI_HMAC_KEY not set; falling back to PHI_ENCRYPTION_KEY. " +
        "This is only permitted outside production."
    );
    return createHmac("sha256", fallback).update(value).digest("hex");
  }
  return createHmac("sha256", hmacKey).update(value).digest("hex");
}

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value: string): string {
    return encrypt(value, getKey());
  },
  fromDriver(value: string): string {
    const previousKey = getPreviousKey();
    if (previousKey) {
      return decryptWithFallback(value, getKey(), previousKey);
    }
    return decrypt(value, getKey());
  },
});

/**
 * Encrypted JSONB custom type. Serializes the JS value to JSON, encrypts the
 * resulting string with AES-256-GCM, and stores it as text. On read, decrypts
 * and parses back into a JS value.
 *
 * Note: this stores the ciphertext in a `text` column (not `jsonb`) because
 * ciphertext is not valid JSON. Query operators that rely on JSONB (e.g. ->,
 * @>) will not work against encrypted columns — callers must read the full
 * value and filter in application code.
 */
export const encryptedJsonb = <T = unknown>() =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: T): string {
      return encrypt(JSON.stringify(value), getKey());
    },
    fromDriver(value: string): T {
      const previousKey = getPreviousKey();
      const plaintext = previousKey
        ? decryptWithFallback(value, getKey(), previousKey)
        : decrypt(value, getKey());
      return JSON.parse(plaintext) as T;
    },
  });
