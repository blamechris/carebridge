import { describe, it, expect, beforeEach } from "vitest";
import { relayStore, RELAY_TTL_MS } from "../lib/relay-store";
import type { BridgeCaptureEnvelope } from "@carebridge/shared-types";

function envelope(captureId = "11111111-1111-4111-8111-111111111111"): BridgeCaptureEnvelope {
  return {
    capture_id: captureId,
    ciphertext: "A".repeat(128),
    uploaded_at: "2026-05-29T10:00:00.000Z",
    expires_at: "2026-05-29T10:15:00.000Z",
  };
}

describe("relayStore", () => {
  beforeEach(() => relayStore._reset());

  it("returns null for unknown codes", () => {
    expect(relayStore.get("UNKNOW")).toBeNull();
  });

  it("returns the envelope and label after put", () => {
    const now = 1_700_000_000_000;
    relayStore.put("K7M4QZ", envelope(), "for Dr Smith", now);
    const hit = relayStore.get("K7M4QZ", now + 1000);
    expect(hit?.envelope.capture_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(hit?.caregiver_label).toBe("for Dr Smith");
  });

  it("expires entries past their TTL and evicts them", () => {
    const now = 1_700_000_000_000;
    relayStore.put("K7M4QZ", envelope(), undefined, now);
    expect(relayStore._size()).toBe(1);
    expect(relayStore.get("K7M4QZ", now + RELAY_TTL_MS + 1)).toBeNull();
    expect(relayStore._size()).toBe(0);
  });

  it("does not leak entries across display codes", () => {
    const now = 1_700_000_000_000;
    relayStore.put("AAAAAA", envelope("aaaa"), undefined, now);
    relayStore.put("BBBBBB", envelope("bbbb"), undefined, now);
    expect(relayStore.get("AAAAAA", now)?.envelope.capture_id).toBe("aaaa");
    expect(relayStore.get("BBBBBB", now)?.envelope.capture_id).toBe("bbbb");
  });
});
