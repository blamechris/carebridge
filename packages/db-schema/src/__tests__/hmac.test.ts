import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hmacForIndex, _resetKeyCache } from "../encryption.js";

const TEST_KEY = randomBytes(32).toString("hex");

describe("hmacForIndex", () => {
  const originalEncKey = process.env.PHI_ENCRYPTION_KEY;
  const originalHmacKey = process.env.PHI_HMAC_KEY;

  before(() => {
    _resetKeyCache();
    process.env.PHI_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.PHI_HMAC_KEY;
  });

  after(() => {
    _resetKeyCache();
    if (originalEncKey !== undefined) {
      process.env.PHI_ENCRYPTION_KEY = originalEncKey;
    } else {
      delete process.env.PHI_ENCRYPTION_KEY;
    }
    if (originalHmacKey !== undefined) {
      process.env.PHI_HMAC_KEY = originalHmacKey;
    } else {
      delete process.env.PHI_HMAC_KEY;
    }
  });

  it("is deterministic — same input always produces the same output", () => {
    const mrn = "MCH-2026-0042";
    const a = hmacForIndex(mrn);
    const b = hmacForIndex(mrn);
    assert.equal(a, b, "HMAC of the same MRN must be identical across calls");
  });

  it("returns a 64-character hex string (SHA-256 digest)", () => {
    const result = hmacForIndex("MRN-12345");
    assert.match(result, /^[0-9a-f]{64}$/, "Should be 64 hex characters");
  });

  it("produces different outputs for different inputs (uniqueness detection)", () => {
    const hmac1 = hmacForIndex("MCH-2026-0042");
    const hmac2 = hmacForIndex("MCH-2026-0043");
    assert.notEqual(hmac1, hmac2, "Different MRNs must produce different HMACs");
  });

  it("uses PHI_HMAC_KEY when available instead of PHI_ENCRYPTION_KEY", () => {
    const separateKey = randomBytes(32).toString("hex");
    const hmacWithEncKey = hmacForIndex("TEST-MRN");

    process.env.PHI_HMAC_KEY = separateKey;
    const hmacWithHmacKey = hmacForIndex("TEST-MRN");
    delete process.env.PHI_HMAC_KEY;

    assert.notEqual(
      hmacWithEncKey,
      hmacWithHmacKey,
      "HMAC should differ when using PHI_HMAC_KEY vs PHI_ENCRYPTION_KEY"
    );
  });

  it("throws when neither PHI_HMAC_KEY nor PHI_ENCRYPTION_KEY is set", () => {
    const savedEnc = process.env.PHI_ENCRYPTION_KEY;
    delete process.env.PHI_ENCRYPTION_KEY;
    delete process.env.PHI_HMAC_KEY;

    assert.throws(
      () => hmacForIndex("anything"),
      /Neither PHI_HMAC_KEY nor PHI_ENCRYPTION_KEY/
    );

    process.env.PHI_ENCRYPTION_KEY = savedEnc;
  });
});
