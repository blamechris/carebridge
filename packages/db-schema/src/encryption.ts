import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { customType } from "drizzle-orm/pg-core";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let _cachedKey: Buffer | null = null;

/** Clear the cached key. Intended for tests that swap PHI_ENCRYPTION_KEY at runtime. */
export function _resetKeyCache(): void {
  _cachedKey = null;
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
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `PHI_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters), got ${buf.length} bytes.`
    );
  }
  _cachedKey = buf;
  return buf;
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

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text";
  },
  toDriver(value: string): string {
    return encrypt(value, getKey());
  },
  fromDriver(value: string): string {
    return decrypt(value, getKey());
  },
});
