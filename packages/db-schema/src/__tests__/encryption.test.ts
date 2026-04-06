import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, decryptWithFallback, getKey, getPreviousKey, _resetKeyCache } from "../encryption.js";

const TEST_KEY = randomBytes(32).toString("hex");

describe("encrypt / decrypt", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "1990-01-15";
    const encrypted = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    assert.equal(decrypted, plaintext);
  });

  it("round-trips unicode content", () => {
    const plaintext = "Maria Garcia-Lopez";
    const encrypted = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    assert.equal(decrypted, plaintext);
  });

  it("round-trips empty string", () => {
    const encrypted = encrypt("", TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    assert.equal(decrypted, "");
  });

  it("produces different ciphertexts for the same plaintext (non-deterministic IVs)", () => {
    const plaintext = "MRN-12345";
    const a = encrypt(plaintext, TEST_KEY);
    const b = encrypt(plaintext, TEST_KEY);
    assert.notEqual(a, b, "Two encryptions of the same plaintext must differ");

    // Both should still decrypt correctly
    assert.equal(decrypt(a, TEST_KEY), plaintext);
    assert.equal(decrypt(b, TEST_KEY), plaintext);
  });

  it("produces iv:authTag:ciphertext format", () => {
    const encrypted = encrypt("test", TEST_KEY);
    const parts = encrypted.split(":");
    assert.equal(parts.length, 3, "Expected 3 colon-separated parts");
    assert.equal(parts[0].length, 32, "IV should be 32 hex chars (16 bytes)");
    assert.equal(parts[1].length, 32, "Auth tag should be 32 hex chars (16 bytes)");
    assert.ok(parts[2].length > 0, "Ciphertext should not be empty");
  });

  it("fails to decrypt with wrong key", () => {
    const wrongKey = randomBytes(32).toString("hex");
    const encrypted = encrypt("secret data", TEST_KEY);

    assert.throws(
      () => decrypt(encrypted, wrongKey),
      (err: unknown) => err instanceof Error,
      "Decryption with wrong key should throw"
    );
  });

  it("fails on malformed ciphertext", () => {
    assert.throws(
      () => decrypt("not-valid-format", TEST_KEY),
      /Invalid encrypted value format/
    );
  });
});

describe("getKey reads PHI_ENCRYPTION_KEY from env", () => {
  const originalKey = process.env.PHI_ENCRYPTION_KEY;

  before(() => {
    _resetKeyCache();
  });

  after(() => {
    _resetKeyCache();
    if (originalKey !== undefined) {
      process.env.PHI_ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.PHI_ENCRYPTION_KEY;
    }
  });

  it("returns a Buffer when a valid 32-byte hex key is set", () => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY = TEST_KEY;
    const key = getKey();
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
  });

  it("encrypt/decrypt round-trips using the env key", () => {
    process.env.PHI_ENCRYPTION_KEY = TEST_KEY;
    const key = getKey();
    const plaintext = "555-0123";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("throws on invalid key length", () => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY = "aabbcc"; // too short
    assert.throws(() => getKey(), /must be exactly 32 bytes/);
  });
});

describe("missing PHI_ENCRYPTION_KEY", () => {
  const originalKey = process.env.PHI_ENCRYPTION_KEY;

  before(() => {
    _resetKeyCache();
    delete process.env.PHI_ENCRYPTION_KEY;
  });

  after(() => {
    _resetKeyCache();
    if (originalKey !== undefined) {
      process.env.PHI_ENCRYPTION_KEY = originalKey;
    }
  });

  it("throws a clear error when key is missing", () => {
    assert.throws(
      () => getKey(),
      /PHI_ENCRYPTION_KEY environment variable is not set/
    );
  });
});

describe("key rotation — decryptWithFallback", () => {
  const OLD_KEY = randomBytes(32).toString("hex");
  const NEW_KEY = randomBytes(32).toString("hex");

  it("decrypts data encrypted with the current key", () => {
    const plaintext = "sensitive-data-123";
    const encrypted = encrypt(plaintext, NEW_KEY);
    const result = decryptWithFallback(encrypted, NEW_KEY, OLD_KEY);
    assert.equal(result, plaintext);
  });

  it("falls back to previous key when current key fails", () => {
    const plaintext = "old-encrypted-data";
    const encrypted = encrypt(plaintext, OLD_KEY);

    // Decrypt with NEW_KEY as current, OLD_KEY as fallback — should succeed
    const result = decryptWithFallback(encrypted, NEW_KEY, OLD_KEY);
    assert.equal(result, plaintext);
  });

  it("throws when neither key can decrypt", () => {
    const unrelatedKey = randomBytes(32).toString("hex");
    const encrypted = encrypt("test", unrelatedKey);

    assert.throws(
      () => decryptWithFallback(encrypted, NEW_KEY, OLD_KEY),
      (err: unknown) => err instanceof Error,
      "Should throw when neither key works"
    );
  });

  it("throws when no previous key and current key fails", () => {
    const encrypted = encrypt("test", OLD_KEY);

    assert.throws(
      () => decryptWithFallback(encrypted, NEW_KEY),
      (err: unknown) => err instanceof Error,
      "Should throw when current key fails and no fallback"
    );
  });

  it("supports full rotation workflow: encrypt old → decrypt with new+fallback → re-encrypt new", () => {
    const plaintext = "patient-mrn-12345";

    // Step 1: Data was encrypted with the old key
    const encryptedWithOld = encrypt(plaintext, OLD_KEY);

    // Step 2: After rotation, decrypt using new key with old as fallback
    const decrypted = decryptWithFallback(encryptedWithOld, NEW_KEY, OLD_KEY);
    assert.equal(decrypted, plaintext);

    // Step 3: Re-encrypt with the new key
    const reEncrypted = encrypt(decrypted, NEW_KEY);

    // Step 4: Now it decrypts with just the new key
    const finalDecrypt = decrypt(reEncrypted, NEW_KEY);
    assert.equal(finalDecrypt, plaintext);
  });
});

describe("getPreviousKey reads PHI_ENCRYPTION_KEY_PREVIOUS from env", () => {
  const originalPrev = process.env.PHI_ENCRYPTION_KEY_PREVIOUS;

  after(() => {
    _resetKeyCache();
    if (originalPrev !== undefined) {
      process.env.PHI_ENCRYPTION_KEY_PREVIOUS = originalPrev;
    } else {
      delete process.env.PHI_ENCRYPTION_KEY_PREVIOUS;
    }
  });

  it("returns null when PHI_ENCRYPTION_KEY_PREVIOUS is not set", () => {
    _resetKeyCache();
    delete process.env.PHI_ENCRYPTION_KEY_PREVIOUS;
    assert.equal(getPreviousKey(), null);
  });

  it("returns a Buffer when a valid key is set", () => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY_PREVIOUS = randomBytes(32).toString("hex");
    const key = getPreviousKey();
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key!.length, 32);
  });

  it("throws on invalid key length", () => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY_PREVIOUS = "aabbcc";
    assert.throws(() => getPreviousKey(), /must be exactly 32 bytes/);
  });
});
