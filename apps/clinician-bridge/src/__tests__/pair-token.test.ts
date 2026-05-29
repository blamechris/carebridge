import { describe, it, expect } from "vitest";
import { generatePairRecord } from "../lib/pair-token";
import {
  bridgePairRecordSchema,
  bridgeDisplayCodeSchema,
  bridgeDecryptionKeySchema,
} from "@carebridge/shared-types";

const TTL_MS = 15 * 60 * 1000;

describe("generatePairRecord", () => {
  it("produces a record that matches the wire schema", () => {
    const rec = generatePairRecord({ ttl_ms: TTL_MS, crypto });
    expect(bridgePairRecordSchema.safeParse(rec).success).toBe(true);
  });

  it("uses the disambiguated alphabet — no O / I / 0 / 1 in display_code", () => {
    // Run a few iterations to lower the false-pass odds for randomness.
    for (let i = 0; i < 50; i++) {
      const rec = generatePairRecord({ ttl_ms: TTL_MS, crypto });
      expect(rec.display_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("emits a 32-byte AES-256-GCM key (43 base64url chars)", () => {
    const rec = generatePairRecord({ ttl_ms: TTL_MS, crypto });
    expect(rec.decryption_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bridgeDecryptionKeySchema.safeParse(rec.decryption_key).success).toBe(true);
  });

  it("sets expires_at to now + ttl_ms", () => {
    const now = Date.parse("2026-05-29T10:00:00.000Z");
    const rec = generatePairRecord({ now, ttl_ms: TTL_MS, crypto });
    expect(rec.expires_at).toBe("2026-05-29T10:15:00.000Z");
  });

  it("returns a fresh capture_id and display_code on each call", () => {
    const a = generatePairRecord({ ttl_ms: TTL_MS, crypto });
    const b = generatePairRecord({ ttl_ms: TTL_MS, crypto });
    expect(a.capture_id).not.toBe(b.capture_id);
    expect(a.display_code === b.display_code).toBe(false);
    expect(bridgeDisplayCodeSchema.safeParse(a.display_code).success).toBe(true);
  });
});
