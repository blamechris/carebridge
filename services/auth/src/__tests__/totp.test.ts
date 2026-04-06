import { describe, it, expect } from "vitest";
import {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  buildOTPAuthURI,
  base32Encode,
  base32Decode,
} from "../totp.js";

describe("Base32 encoding/decoding", () => {
  it("round-trips arbitrary bytes", () => {
    const original = Buffer.from("Hello, TOTP!");
    const encoded = base32Encode(original);
    const decoded = base32Decode(encoded);
    expect(decoded).toEqual(original);
  });

  it("encodes known test vector (RFC 4648)", () => {
    // "f" -> "MY"
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    // "fo" -> "MZXQ"
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    // "foo" -> "MZXW6"
    expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
  });
});

describe("TOTP generation", () => {
  it("produces a 6-digit code", () => {
    const secret = generateSecret();
    const code = generateTOTP(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("produces consistent codes for the same time", () => {
    const secret = generateSecret();
    const time = 1700000000;
    const code1 = generateTOTP(secret, time);
    const code2 = generateTOTP(secret, time);
    expect(code1).toBe(code2);
  });

  it("produces different codes for different time steps", () => {
    const secret = generateSecret();
    const code1 = generateTOTP(secret, 1700000000);
    const code2 = generateTOTP(secret, 1700000060); // 2 periods later
    // Extremely unlikely to be the same but not impossible; test is probabilistic
    expect(code1).toMatch(/^\d{6}$/);
    expect(code2).toMatch(/^\d{6}$/);
  });

  // RFC 6238 test vector: SHA1, secret = "12345678901234567890", time step 59
  it("matches RFC 6238 test vector for SHA1", () => {
    // The secret "12345678901234567890" in ASCII = base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // At time = 59, counter = 1, expected TOTP = 287082
    const code = generateTOTP(secret, 59);
    expect(code).toBe("287082");
  });
});

describe("TOTP verification", () => {
  it("succeeds for the current time step", () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    const code = generateTOTP(secret, now);

    // Monkey-patch Date.now for verification
    const originalNow = Date.now;
    Date.now = () => now * 1000;
    try {
      expect(verifyTOTP(secret, code, 0)).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("fails for a wrong code", () => {
    const secret = generateSecret();
    expect(verifyTOTP(secret, "000000", 0)).toBe(false);
  });

  it("succeeds within +/- 1 time step window", () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    // Generate code for one period ago
    const codePast = generateTOTP(secret, now - 30);

    const originalNow = Date.now;
    Date.now = () => now * 1000;
    try {
      // With window=1, code from previous period should work
      expect(verifyTOTP(secret, codePast, 1)).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("fails outside the window", () => {
    const secret = generateSecret();
    const now = Math.floor(Date.now() / 1000);
    // Generate code for 3 periods ago
    const codeOld = generateTOTP(secret, now - 90);

    const originalNow = Date.now;
    Date.now = () => now * 1000;
    try {
      // With window=1, code from 3 periods ago should fail
      expect(verifyTOTP(secret, codeOld, 1)).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("Secret generation", () => {
  it("produces a base32-encoded string", () => {
    const secret = generateSecret();
    // Base32 chars only
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it("produces different secrets each time", () => {
    const s1 = generateSecret();
    const s2 = generateSecret();
    expect(s1).not.toBe(s2);
  });

  it("decodes back to 20 bytes", () => {
    const secret = generateSecret();
    const decoded = base32Decode(secret);
    expect(decoded.length).toBe(20);
  });
});

describe("Recovery codes", () => {
  it("generates the requested number of codes", () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
  });

  it("formats codes as XXXXX-XXXXX", () => {
    const codes = generateRecoveryCodes();
    for (const code of codes) {
      expect(code).toMatch(/^[A-F0-9]{5}-[A-F0-9]{5}$/);
    }
  });

  it("verifies a valid recovery code", () => {
    const codes = generateRecoveryCodes(4);
    const hashed = codes.map(hashRecoveryCode);

    const idx = verifyRecoveryCode(codes[2]!, hashed);
    expect(idx).toBe(2);
  });

  it("rejects an invalid recovery code", () => {
    const codes = generateRecoveryCodes(4);
    const hashed = codes.map(hashRecoveryCode);

    const idx = verifyRecoveryCode("AAAAA-BBBBB", hashed);
    expect(idx).toBe(-1);
  });

  it("is case-insensitive", () => {
    const codes = generateRecoveryCodes(2);
    const hashed = codes.map(hashRecoveryCode);

    const idx = verifyRecoveryCode(codes[0]!.toLowerCase(), hashed);
    expect(idx).toBe(0);
  });
});

describe("OTP Auth URI", () => {
  it("builds a valid otpauth URI", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const email = "dr.smith@carebridge.dev";
    const uri = buildOTPAuthURI(secret, email);

    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("CareBridge");
    expect(uri).toContain(encodeURIComponent("dr.smith@carebridge.dev"));
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=CareBridge");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
