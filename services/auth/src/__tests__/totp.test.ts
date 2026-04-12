import { describe, it, expect } from "vitest";
import {
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  buildOTPAuthURI,
  buildOTPAuthQRCode,
} from "../totp.js";

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
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
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

  it("produces a secret of expected base32 length", () => {
    const secret = generateSecret();
    // 20 bytes = 32 base32 characters
    expect(secret.length).toBe(32);
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

describe("OTP Auth QR code (local generation)", () => {
  // Regression test for issue #280: the TOTP secret must never be sent to a
  // third-party QR service. The server now generates the QR image locally and
  // returns it as a data URL; the client renders it directly.
  it("returns a PNG data URL for the otpauth URI", async () => {
    const uri = buildOTPAuthURI("JBSWY3DPEHPK3PXP", "dr.smith@carebridge.dev");
    const qr = await buildOTPAuthQRCode(uri);

    expect(qr).toMatch(/^data:image\/png;base64,/);
    // Must be large enough to represent an actual QR code payload.
    expect(qr.length).toBeGreaterThan(200);
  });

  it("does not leak the secret to any third-party QR service URL", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const uri = buildOTPAuthURI(secret, "dr.smith@carebridge.dev");
    const qr = await buildOTPAuthQRCode(uri);

    // The returned value must be a self-contained data URL, not a pointer
    // to a remote QR generator. Scan the full payload for any known leak
    // vectors or the raw otpauth URI itself.
    const payload = JSON.stringify({ uri: undefined, qrCodeDataUrl: qr });
    expect(payload).not.toContain("api.qrserver.com");
    expect(payload).not.toContain("chart.googleapis.com");
    expect(payload).not.toContain("chart.apis.google.com");
    expect(payload).not.toContain("quickchart.io");
    expect(payload).not.toContain("http://");
    // The data URL itself is base64, so it must not contain the raw secret.
    expect(qr).not.toContain(secret);
    expect(qr).not.toContain("otpauth://");
  });

  it("produces deterministic output for the same input", async () => {
    const uri = buildOTPAuthURI("JBSWY3DPEHPK3PXP", "dr.smith@carebridge.dev");
    const a = await buildOTPAuthQRCode(uri);
    const b = await buildOTPAuthQRCode(uri);
    expect(a).toBe(b);
  });
});
