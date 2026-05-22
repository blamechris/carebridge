/**
 * Canonical URL namespace for CareBridge-minted FHIR identifiers.
 *
 * Using a URL-form `system` rather than an ad-hoc `urn:` scheme is the
 * shape Epic, Cerner, and other major EHRs are trained to recognise.
 *
 * Convention: append a domain-specific path segment (`/user-id`,
 * `/mrn`, `/encounter-id`, …) under this base so every resource
 * generator reuses the same namespace root.
 *
 * Hoisted out of practitioner.ts in #969 — patient.ts previously used an
 * unrelated `http://carebridge.health/mrn` namespace (different domain,
 * different scheme, different path shape). Sharing this constant keeps
 * any new CareBridge identifier consistent.
 */
export const CAREBRIDGE_IDENTIFIER_BASE =
  "https://carebridge.dev/fhir/sid";
