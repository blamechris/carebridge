/**
 * FHIR R4 Practitioner resource generator (issue #388).
 *
 * Maps internal `users` rows with clinical roles (physician, specialist,
 * nurse) to the HL7 FHIR R4 Practitioner resource
 * (https://hl7.org/fhir/R4/practitioner.html).
 *
 * Only clinical roles produce a Practitioner. Patients and admins are
 * filtered out by the caller (see `isClinicalRole` below).
 */

import type { users } from "@carebridge/db-schema";
import type { FhirPractitioner, HumanName } from "../types/fhir-r4.js";

type UserRow = typeof users.$inferSelect;

const CLINICAL_ROLES = new Set(["physician", "specialist", "nurse"]);

/** True when the user row represents a clinician and should produce a Practitioner resource. */
export function isClinicalRole(role: string): boolean {
  return CLINICAL_ROLES.has(role);
}

/**
 * Parse a free-text full name into FHIR HumanName's `family` + `given` fields.
 *
 * The users table stores name as a single string (e.g. "Sarah Jones" or
 * "Sarah M. Jones, MD"). FHIR consumers expect a structured split so they
 * can render `{given[0]} {family}` or `{family}, {given[0]}` to taste.
 *
 * Heuristic: the last whitespace-separated token is the family name; the
 * preceding tokens are given names. Trailing credentials after a comma
 * ("Jones, MD") are trimmed. Caller rows with a single-token name get the
 * token as `family` with no `given`.
 */
function parseName(fullName: string): HumanName {
  // Strip any trailing ", MD" / ", RN" / ", PhD" credentials.
  const beforeComma = fullName.split(",")[0]!.trim();
  const tokens = beforeComma.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return { text: fullName };
  }
  if (tokens.length === 1) {
    return { text: fullName, family: tokens[0]! };
  }
  const family = tokens[tokens.length - 1]!;
  const given = tokens.slice(0, -1);
  return { text: fullName, family, given };
}

/**
 * Canonical URL namespace for CareBridge-minted FHIR identifiers. Using
 * a URL-form `system` rather than an ad-hoc `urn:` scheme is the shape
 * Epic, Cerner, and other major EHRs are trained to recognise.
 *
 * Convention: append a domain-specific path segment (`/user-id`,
 * `/patient-id`, `/encounter-id`, …) under this base so new resource
 * generators reuse the same namespace root.
 */
export const CAREBRIDGE_IDENTIFIER_BASE =
  "https://carebridge.dev/fhir/sid";

export function toFhirPractitioner(user: UserRow): FhirPractitioner {
  const resource: FhirPractitioner = {
    resourceType: "Practitioner",
    id: user.id,
    identifier: [
      {
        system: `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
        value: user.id,
      },
    ],
    name: [parseName(user.name)],
  };

  // Qualification / specialty — surfaced as a text-only CodeableConcept.
  // We intentionally avoid emitting a NUCC taxonomy code unless the
  // internal table starts storing a coded value; a wrong code is worse
  // for interop than an absent one.
  if (user.specialty) {
    resource.qualification = [
      {
        code: {
          text: user.specialty,
        },
      },
    ];
  }

  return resource;
}
