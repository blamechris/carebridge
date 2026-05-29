import { describe, it, expect } from "vitest";
import {
  bridgeDisplayCodeSchema,
  bridgeDecryptionKeySchema,
  bridgeCiphertextSchema,
  bridgePairRecordSchema,
  bridgePairRequestSchema,
  bridgeCaptureEnvelopeSchema,
  bridgeQrPayloadSchema,
} from "../bridge-protocol.schemas.js";

const VALID_KEY = "a".repeat(43);
const VALID_UUID = "00000000-0000-4000-8000-000000000000";
const VALID_CIPHERTEXT = "A".repeat(128);
const VALID_TIMESTAMP = "2026-05-29T10:00:00.000Z";

describe("bridgeDisplayCodeSchema", () => {
  it("accepts a valid 6-char base32 code", () => {
    for (const code of ["K7M4QZ", "ABCDEF", "23456789".slice(0, 6)]) {
      expect(bridgeDisplayCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("rejects codes containing the ambiguous chars 0, O, 1, I", () => {
    for (const code of ["K0M4QZ", "K7O4QZ", "K7M1QZ", "I7M4QZ"]) {
      expect(bridgeDisplayCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it("rejects wrong-length codes", () => {
    for (const code of ["K7M4Q", "K7M4QZZ", ""]) {
      expect(bridgeDisplayCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it("rejects lowercase", () => {
    expect(bridgeDisplayCodeSchema.safeParse("k7m4qz").success).toBe(false);
  });
});

describe("bridgeDecryptionKeySchema", () => {
  it("accepts a 43-char base64url string", () => {
    expect(bridgeDecryptionKeySchema.safeParse(VALID_KEY).success).toBe(true);
  });

  it("rejects keys with base64 padding (=)", () => {
    const padded = "a".repeat(42) + "=";
    expect(bridgeDecryptionKeySchema.safeParse(padded).success).toBe(false);
  });

  it("rejects keys with the wrong length (32-byte AES-256-GCM only)", () => {
    expect(bridgeDecryptionKeySchema.safeParse("a".repeat(22)).success).toBe(false); // 16-byte key
    expect(bridgeDecryptionKeySchema.safeParse("a".repeat(86)).success).toBe(false); // 64-byte
  });
});

describe("bridgeCiphertextSchema", () => {
  it("accepts a base64url string within bounds", () => {
    expect(bridgeCiphertextSchema.safeParse(VALID_CIPHERTEXT).success).toBe(true);
  });

  it("rejects ciphertext below the floor (would be smaller than IV+tag)", () => {
    expect(bridgeCiphertextSchema.safeParse("A".repeat(32)).success).toBe(false);
  });

  it("rejects ciphertext exceeding the 100KB cap", () => {
    expect(bridgeCiphertextSchema.safeParse("A".repeat(100_001)).success).toBe(false);
  });

  it("rejects non-base64url characters", () => {
    const bad = "A".repeat(63) + "!";
    expect(bridgeCiphertextSchema.safeParse(bad).success).toBe(false);
  });
});

describe("bridgePairRecordSchema", () => {
  const valid = {
    capture_id: VALID_UUID,
    display_code: "K7M4QZ",
    expires_at: VALID_TIMESTAMP,
    decryption_key: VALID_KEY,
  };

  it("accepts a complete valid record", () => {
    expect(bridgePairRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects on a missing field", () => {
    const { decryption_key: _omit, ...partial } = valid;
    expect(bridgePairRecordSchema.safeParse(partial).success).toBe(false);
  });
});

describe("bridgePairRequestSchema", () => {
  it("accepts a request with no caregiver_label", () => {
    expect(
      bridgePairRequestSchema.safeParse({ ciphertext: VALID_CIPHERTEXT }).success,
    ).toBe(true);
  });

  it("accepts a request with a label up to 80 chars", () => {
    expect(
      bridgePairRequestSchema.safeParse({
        ciphertext: VALID_CIPHERTEXT,
        caregiver_label: "a".repeat(80),
      }).success,
    ).toBe(true);
  });

  it("rejects a label over 80 chars", () => {
    expect(
      bridgePairRequestSchema.safeParse({
        ciphertext: VALID_CIPHERTEXT,
        caregiver_label: "a".repeat(81),
      }).success,
    ).toBe(false);
  });
});

describe("bridgeCaptureEnvelopeSchema", () => {
  it("accepts a complete envelope", () => {
    expect(
      bridgeCaptureEnvelopeSchema.safeParse({
        capture_id: VALID_UUID,
        ciphertext: VALID_CIPHERTEXT,
        uploaded_at: VALID_TIMESTAMP,
        expires_at: VALID_TIMESTAMP,
      }).success,
    ).toBe(true);
  });
});

describe("bridgeQrPayloadSchema", () => {
  it("accepts a v1 payload", () => {
    expect(
      bridgeQrPayloadSchema.safeParse({
        v: "1",
        token: {
          capture_id: VALID_UUID,
          display_code: "K7M4QZ",
          expires_at: VALID_TIMESTAMP,
          decryption_key: VALID_KEY,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown protocol version", () => {
    expect(
      bridgeQrPayloadSchema.safeParse({
        v: "2",
        token: {
          capture_id: VALID_UUID,
          display_code: "K7M4QZ",
          expires_at: VALID_TIMESTAMP,
          decryption_key: VALID_KEY,
        },
      }).success,
    ).toBe(false);
  });
});
