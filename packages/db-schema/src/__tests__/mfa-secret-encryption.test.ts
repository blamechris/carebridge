import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, getKey, _resetKeyCache } from "../encryption.js";

const TEST_KEY = randomBytes(32).toString("hex");

describe("MFA secret encryption at rest", () => {
  const originalKey = process.env.PHI_ENCRYPTION_KEY;

  before(() => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY = TEST_KEY;
  });

  after(() => {
    _resetKeyCache();
    if (originalKey !== undefined) {
      process.env.PHI_ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.PHI_ENCRYPTION_KEY;
    }
  });

  it("stored value is encrypted (not the plaintext TOTP secret)", () => {
    const secret = "JBSWY3DPEHPK3PXP"; // sample base32 TOTP secret
    const key = getKey();

    // Simulate what encryptedText.toDriver does on write
    const stored = encrypt(secret, key);

    // The value persisted to the database must NOT be the plaintext
    assert.notEqual(stored, secret, "Stored value must not be the plaintext secret");

    // It must not contain the plaintext as a substring either
    assert.ok(
      !stored.includes(secret),
      "Stored value must not contain the plaintext secret",
    );

    // It should be in the iv:authTag:ciphertext format
    const parts = stored.split(":");
    assert.equal(parts.length, 3, "Expected iv:authTag:ciphertext format");
  });

  it("decrypts back to the original TOTP secret", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const key = getKey();

    const stored = encrypt(secret, key);
    const recovered = decrypt(stored, key);

    assert.equal(recovered, secret, "Decrypted value must match original secret");
  });

  it("each write produces a different ciphertext (unique IVs)", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const key = getKey();

    const a = encrypt(secret, key);
    const b = encrypt(secret, key);

    assert.notEqual(a, b, "Each encryption must produce a unique ciphertext");

    // Both must still decrypt correctly
    assert.equal(decrypt(a, key), secret);
    assert.equal(decrypt(b, key), secret);
  });
});
