/**
 * Bridge protocol — wire contract for the MedLens → clinician-bridge handoff.
 *
 * See `docs/clinician-bridge-mvp.md` for the full architecture. The protocol
 * is small by design: the relay holds an opaque encrypted blob, and the
 * decryption key never touches the relay — it travels with the paired
 * token (QR + 6-char code) directly from the caregiver's phone to the
 * clinician's device.
 *
 * The decrypted payload is a FHIR R4 Bundle (see
 * `services/fhir-gateway/src/schemas/bundle.ts` — `fhirBundleSchema`).
 * This file does not redeclare the payload shape; it only defines the
 * envelope and the pair-token shape.
 *
 * Token lifetime: 15 minutes, single-use. Code length: 6 characters,
 * base32 ([A-Z2-7], excludes 0/O/1/I to avoid OCR ambiguity).
 */

/**
 * The pair response returned by `POST /api/v1/pair` to the MedLens
 * client. Deliberately does NOT contain the decryption key — the key
 * is generated client-side by MedLens and never crosses the wire to
 * the relay (D1 in `docs/clinician-bridge-mvp.md` says "the relay
 * sees ciphertext only").
 */
export interface BridgePairResponse {
  /** Opaque capture identifier; for audit and debugging only. */
  capture_id: string;
  /** 6-character base32 code, e.g. "K7M4QZ". Excludes 0/O/1/I. */
  display_code: string;
  /** ISO 8601 timestamp; 15 minutes from issuance. */
  expires_at: string;
}

/**
 * The QR-encoded token the clinician's bridge device parses. The
 * MedLens client builds this client-side by combining the relay's
 * `BridgePairResponse` with the AES-256-GCM key it generated locally
 * and used to encrypt the ciphertext before upload. The relay never
 * sees this combined form.
 */
export interface BridgePairToken {
  capture_id: string;
  display_code: string;
  expires_at: string;
  /**
   * Base64url-encoded AES-256-GCM key (43 chars = 32 bytes). Generated
   * on the MedLens device, embedded in the QR, never sent to the relay.
   */
  decryption_key: string;
}

/**
 * The envelope the relay actually stores. Contains only ciphertext and
 * non-identifying metadata. PHI lives inside `ciphertext` and is
 * opaque to the relay.
 */
export interface BridgeCaptureEnvelope {
  capture_id: string;
  /**
   * Base64url-encoded AES-256-GCM output. The first 12 bytes (after
   * base64url-decode) are the IV; the remainder is ciphertext +
   * 16-byte auth tag (GCM standard layout).
   */
  ciphertext: string;
  /** ISO 8601 timestamp of upload. */
  uploaded_at: string;
  /** ISO 8601 timestamp of TTL expiry; equal to `BridgePairRecord.expires_at`. */
  expires_at: string;
}

/**
 * Request body for `POST /api/v1/pair` from the MedLens client. The
 * client encrypts the FHIR Bundle locally before sending; the relay
 * only sees ciphertext.
 *
 * The relay returns a `BridgePairRecord` and stores the envelope under
 * `capture_id` for 15 minutes.
 */
export interface BridgePairRequest {
  ciphertext: string;
  /**
   * Free-text caregiver label, e.g. "for Dr. Smith" or "ER trip 5/29".
   * Display-only in the bridge UI; helps a clinician confirm they have
   * the right capture. Capped at 80 chars by the relay.
   */
  caregiver_label?: string;
}

/**
 * The pairing payload encoded into the QR.
 *
 * Format: JSON-stringified `BridgePairToken`, then base64url. The
 * leading `v` byte (currently `"1"`) lets us version the format if we
 * later need to embed additional fields.
 *
 * Helper functions for encoding/decoding live in
 * `apps/clinician-bridge/src/lib/pair-token.ts` so the bridge app and
 * MedLens (which will vendor a copy) implement the same algorithm.
 */
export interface BridgeQrPayload {
  /** Format version. `"1"` at MVP. */
  v: "1";
  token: BridgePairToken;
}

/**
 * @deprecated Use `BridgePairResponse` (relay → client, no key) or
 *   `BridgePairToken` (client-built, has key). Kept temporarily for
 *   call sites that imported the old name.
 */
export type BridgePairRecord = BridgePairToken;
