import {
  bridgeDisplayCodeSchema,
  bridgeCaptureIdSchema,
} from "@carebridge/shared-types";
import type { BridgePairResponse } from "@carebridge/shared-types";

/**
 * Display-code alphabet — base32-ish, excludes 0/O/1/I to avoid OCR /
 * read-aloud ambiguity. Keep in lock-step with `bridgeDisplayCodeSchema`
 * regex in shared-types.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISPLAY_CODE_LENGTH = 6;

/**
 * Generate a relay-side pair response — no decryption key. The key is
 * generated client-side on the MedLens device and never touches the
 * relay. Pure-ish: accepts a crypto provider so tests can inject a
 * deterministic implementation.
 */
export function generatePairResponse(opts: {
  now?: number;
  ttl_ms: number;
  crypto: Pick<Crypto, "getRandomValues" | "randomUUID">;
}): BridgePairResponse {
  const now = opts.now ?? Date.now();
  const capture_id = opts.crypto.randomUUID();
  const display_code = generateDisplayCode(opts.crypto);
  const expires_at = new Date(now + opts.ttl_ms).toISOString();

  // Sanity check — must match the schemas the relay validates against.
  bridgeCaptureIdSchema.parse(capture_id);
  bridgeDisplayCodeSchema.parse(display_code);

  return { capture_id, display_code, expires_at };
}

function generateDisplayCode(crypto: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(DISPLAY_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}
