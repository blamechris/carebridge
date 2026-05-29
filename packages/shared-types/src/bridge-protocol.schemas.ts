import { z } from "zod";

/**
 * Runtime schemas for the bridge protocol — see
 * `./bridge-protocol.ts` for the types and `docs/clinician-bridge-mvp.md`
 * for the full architecture.
 *
 * The relay validates inbound requests against these schemas before
 * touching storage. They are intentionally strict — anything outside
 * the contract should be rejected, not coerced.
 */

/** Base32 character set without 0/O/1/I (Crockford-ish), 6 chars. */
export const bridgeDisplayCodeSchema = z
  .string()
  .regex(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/,
    "display_code must be 6 base32 characters (A-Z minus O/I, 2-9 minus 0/1)",
  );

/** UUID v4 produced by the relay at pair time. */
export const bridgeCaptureIdSchema = z.string().uuid();

/**
 * AES-256-GCM key, base64url-encoded. Decoded length is exactly 32 bytes
 * (256 bits). The base64url representation is 43 characters with no
 * padding.
 */
export const bridgeDecryptionKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "decryption_key must be 43 base64url chars (32-byte key, no padding)");

/**
 * Ciphertext envelope. Format: base64url-encoded IV (12 bytes) + GCM
 * ciphertext + auth tag (16 bytes). Min ciphertext payload is the
 * smallest credible FHIR bundle (~256 bytes) after encryption; max is
 * 64 KiB to bound relay memory.
 *
 * After base64url-decode the binary blob is `IV (12) || ciphertext ||
 * authTag (16)`, so we accept any base64url string between 64 and
 * 100_000 characters.
 */
export const bridgeCiphertextSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "ciphertext must be base64url-encoded")
  .min(64)
  .max(100_000);

/** Caregiver-set label; bridge displays verbatim, capped to keep UI tidy. */
export const bridgeCaregiverLabelSchema = z.string().max(80).optional();

/** Relay → client (no key). */
export const bridgePairResponseSchema = z.object({
  capture_id: bridgeCaptureIdSchema,
  display_code: bridgeDisplayCodeSchema,
  expires_at: z.string().datetime(),
});

/** Client-built (has key) — what the QR encodes. */
export const bridgePairTokenSchema = z.object({
  capture_id: bridgeCaptureIdSchema,
  display_code: bridgeDisplayCodeSchema,
  expires_at: z.string().datetime(),
  decryption_key: bridgeDecryptionKeySchema,
});

/** @deprecated Use `bridgePairResponseSchema` or `bridgePairTokenSchema`. */
export const bridgePairRecordSchema = bridgePairTokenSchema;

export const bridgePairRequestSchema = z.object({
  ciphertext: bridgeCiphertextSchema,
  caregiver_label: bridgeCaregiverLabelSchema,
});

export const bridgeCaptureEnvelopeSchema = z.object({
  capture_id: bridgeCaptureIdSchema,
  ciphertext: bridgeCiphertextSchema,
  uploaded_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export const bridgeQrPayloadSchema = z.object({
  v: z.literal("1"),
  token: bridgePairTokenSchema,
});
