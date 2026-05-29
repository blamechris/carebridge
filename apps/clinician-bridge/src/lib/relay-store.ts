import type { BridgeCaptureEnvelope } from "@carebridge/shared-types";

/**
 * In-memory relay store — DEV ONLY.
 *
 * Production replaces this with Vercel KV (or Cloudflare R2) so cold
 * starts don't drop in-flight captures. The 15-min TTL is short enough
 * that "dropped on cold start" is an acceptable failure mode in dev.
 *
 * Indexed by display_code (the 6-char human-readable handle). The
 * envelope contains capture_id internally; nothing reads it externally.
 */

interface StoredRecord {
  envelope: BridgeCaptureEnvelope;
  expires_at_ms: number;
  /** Optional caregiver-set label for the bridge UI. */
  caregiver_label?: string;
}

const TTL_MS = 15 * 60 * 1000;

class RelayStore {
  private byDisplayCode = new Map<string, StoredRecord>();

  put(
    displayCode: string,
    envelope: BridgeCaptureEnvelope,
    caregiverLabel: string | undefined,
    now: number = Date.now(),
  ): void {
    this.byDisplayCode.set(displayCode, {
      envelope,
      expires_at_ms: now + TTL_MS,
      caregiver_label: caregiverLabel,
    });
  }

  get(
    displayCode: string,
    now: number = Date.now(),
  ): { envelope: BridgeCaptureEnvelope; caregiver_label?: string } | null {
    const rec = this.byDisplayCode.get(displayCode);
    if (!rec) return null;
    if (rec.expires_at_ms <= now) {
      this.byDisplayCode.delete(displayCode);
      return null;
    }
    return { envelope: rec.envelope, caregiver_label: rec.caregiver_label };
  }

  /** Test-only: clear everything. */
  _reset(): void {
    this.byDisplayCode.clear();
  }

  /** Test-only: peek the raw map size. */
  _size(): number {
    return this.byDisplayCode.size;
  }
}

/**
 * Module-level singleton. Next.js route handlers re-import this module
 * across requests inside a single warm instance, so the Map persists
 * for the lifetime of the lambda. Cold starts reset it — acceptable
 * for the 15-min TTL window.
 */
export const relayStore = new RelayStore();

export const RELAY_TTL_MS = TTL_MS;
