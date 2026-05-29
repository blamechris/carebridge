import {
  bridgeDisplayCodeSchema,
  bridgeDecryptionKeySchema,
  bridgeCaptureIdSchema,
} from "@carebridge/shared-types";
import type { BridgePairRecord } from "@carebridge/shared-types";

/**
 * Display-code alphabet — base32-ish, excludes 0/O/1/I to avoid OCR /
 * read-aloud ambiguity. Keep in lock-step with `bridgeDisplayCodeSchema`
 * regex in shared-types.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISPLAY_CODE_LENGTH = 6;
const KEY_BYTES = 32;

/**
 * Generate a single pair record. Pure-ish — accepts a crypto provider so
 * tests can inject a deterministic implementation.
 */
export function generatePairRecord(opts: {
  now?: number;
  ttl_ms: number;
  crypto: Pick<Crypto, "getRandomValues" | "randomUUID">;
}): BridgePairRecord {
  const now = opts.now ?? Date.now();
  const capture_id = opts.crypto.randomUUID();
  const display_code = generateDisplayCode(opts.crypto);
  const decryption_key = generateDecryptionKey(opts.crypto);
  const expires_at = new Date(now + opts.ttl_ms).toISOString();

  // Sanity check — must match the schemas the relay will validate against.
  bridgeCaptureIdSchema.parse(capture_id);
  bridgeDisplayCodeSchema.parse(display_code);
  bridgeDecryptionKeySchema.parse(decryption_key);

  return { capture_id, display_code, expires_at, decryption_key };
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

function generateDecryptionKey(crypto: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  // Build a string of binary chars, then btoa, then translate to base64url.
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = (globalThis.btoa ?? nodeBtoa)(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nodeBtoa(s: string): string {
  return Buffer.from(s, "binary").toString("base64");
}
