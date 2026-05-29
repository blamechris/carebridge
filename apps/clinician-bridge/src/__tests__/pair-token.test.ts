import { describe, it, expect } from "vitest";
import { generatePairResponse } from "../lib/pair-token";
import {
  bridgePairResponseSchema,
  bridgeDisplayCodeSchema,
} from "@carebridge/shared-types";

const TTL_MS = 15 * 60 * 1000;

describe("generatePairResponse", () => {
  it("produces a response that matches the wire schema", () => {
    const rec = generatePairResponse({ ttl_ms: TTL_MS, crypto });
    expect(bridgePairResponseSchema.safeParse(rec).success).toBe(true);
  });

  it("uses the disambiguated alphabet — no O / I / 0 / 1 in display_code", () => {
    for (let i = 0; i < 50; i++) {
      const rec = generatePairResponse({ ttl_ms: TTL_MS, crypto });
      expect(rec.display_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("does not include a decryption_key (relay never sees it)", () => {
    const rec = generatePairResponse({ ttl_ms: TTL_MS, crypto }) as Record<string, unknown>;
    expect("decryption_key" in rec).toBe(false);
  });

  it("sets expires_at to now + ttl_ms", () => {
    const now = Date.parse("2026-05-29T10:00:00.000Z");
    const rec = generatePairResponse({ now, ttl_ms: TTL_MS, crypto });
    expect(rec.expires_at).toBe("2026-05-29T10:15:00.000Z");
  });

  it("returns a fresh capture_id and display_code on each call", () => {
    const a = generatePairResponse({ ttl_ms: TTL_MS, crypto });
    const b = generatePairResponse({ ttl_ms: TTL_MS, crypto });
    expect(a.capture_id).not.toBe(b.capture_id);
    expect(a.display_code === b.display_code).toBe(false);
    expect(bridgeDisplayCodeSchema.safeParse(a.display_code).success).toBe(true);
  });
});
