/**
 * Helpers for handling Epic SMART-launch URL parameters (#1188).
 *
 * The SMART App Launch callback in
 * services/api-gateway/src/routes/epic-auth.ts appends
 * `?epic_patient=<fhir-id>` to the post-launch redirect. Components that
 * consume the launch context — currently `<EpicSyncCard>` — accept the
 * value as a prop, so we read it from `useSearchParams()` on the page
 * and forward it after validation.
 *
 * The validator enforces FHIR `id` grammar (R4 §2.36.1.4): up to 64
 * characters of `[A-Za-z0-9.-]`. We intentionally do NOT call
 * `decodeURIComponent` — `URLSearchParams.get()` already returns the
 * decoded string, and double-decoding would let a malicious URL smuggle
 * reserved characters past the regex.
 */

/** Maximum FHIR id length per R4 spec. */
export const FHIR_ID_MAX_LENGTH = 64;

/** FHIR id grammar: alphanumerics, hyphen, period. */
const FHIR_ID_PATTERN = /^[A-Za-z0-9.\-]+$/;

/**
 * Returns the input if it is a well-formed FHIR id (non-empty, within
 * the 64-char limit, only alphanumerics + `-` + `.`); otherwise
 * `undefined`. Callers should forward the returned value as-is — a
 * `null` or invalid input becomes `undefined`, which downstream
 * mutations treat as "no override" and fall back to the stored
 * patient-FHIR mapping.
 */
export function parseEpicPatientParam(
  raw: string | null | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > FHIR_ID_MAX_LENGTH) return undefined;
  if (!FHIR_ID_PATTERN.test(raw)) return undefined;
  return raw;
}
