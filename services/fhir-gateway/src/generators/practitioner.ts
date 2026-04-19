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
 * Particles that attach to the family name and should travel with it:
 *  - Spanish / Portuguese: de, del, de la, de los, de las, da, das, do, dos
 *  - Dutch / German: van, van der, van den, von, zu
 *  - Arabic / Semitic: bin, ibn, abu, al
 *  - French: de, du, le, la
 *
 * Kept lowercase; matching lowercases the token before comparison.
 */
const FAMILY_PARTICLES = new Set([
  "de",
  "del",
  "da",
  "das",
  "do",
  "dos",
  "di",
  "la",
  "las",
  "los",
  "le",
  "du",
  "van",
  "von",
  "der",
  "den",
  "zu",
  "bin",
  "ibn",
  "abu",
  "al",
]);

/**
 * Parse a free-text full name into FHIR HumanName's `family` + `given` fields.
 *
 * The users table stores name as a single string (e.g. "Sarah Jones" or
 * "Sarah M. Jones, MD"). FHIR consumers expect a structured split so they
 * can render `{given[0]} {family}` or `{family}, {given[0]}` to taste.
 *
 * Heuristic:
 *  1. Strip trailing credentials after a comma ("Jones, MD").
 *  2. Walk tokens from the right, accreting into `family` while tokens are
 *     either FAMILY_PARTICLES (de, del, van, von, bin, ibn, …) OR the last
 *     two non-particle tokens when there are ≥3 tokens total. This keeps
 *     Hispanic two-part surnames ("María García López" → family "García
 *     López") and particle-prefixed family names ("Sarah de Klerk" →
 *     family "de Klerk") intact.
 *  3. Hyphenated surnames ("Smith-Jones") stay as one token and need no
 *     special handling.
 *
 * This is a heuristic; structured name fields on the users table are the
 * long-term fix (see issue #944 for the migration plan).
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
  if (tokens.length === 2) {
    // "Sarah Jones" — the simple majority case.
    return { text: fullName, family: tokens[1]!, given: [tokens[0]!] };
  }

  // Three-or-more tokens. Default to Hispanic-style two-part surname
  // (penultimate + last), then pull in any preceding FAMILY_PARTICLES
  // that prefix the family group. If no particle precedes the pair, we
  // fall back to Anglo one-word family to keep "Sarah M. Jones" working.
  const last = tokens[tokens.length - 1]!;
  const penultimate = tokens[tokens.length - 2]!;

  // Anglo middle-initial / middle-name shape: detect when the penultimate
  // token is a bare initial ("M." or "M") so we don't treat "Sarah M.
  // Jones" as "given=Sarah, family=M. Jones".
  const penultimateIsInitial = /^[A-Za-z]\.?$/.test(penultimate);

  let familyTokens: string[];
  let givenTokens: string[];

  if (penultimateIsInitial) {
    // "Sarah M. Jones" → family = last, given = everything else.
    familyTokens = [last];
    givenTokens = tokens.slice(0, -1);
  } else {
    // Hispanic / Portuguese two-part family: start with penultimate + last.
    familyTokens = [penultimate, last];
    givenTokens = tokens.slice(0, -2);
  }

  // Absorb particle chain immediately preceding the family.
  while (
    givenTokens.length > 0 &&
    FAMILY_PARTICLES.has(givenTokens[givenTokens.length - 1]!.toLowerCase())
  ) {
    familyTokens.unshift(givenTokens.pop()!);
  }

  return {
    text: fullName,
    family: familyTokens.join(" "),
    given: givenTokens.length > 0 ? givenTokens : undefined,
  };
}

export function toFhirPractitioner(user: UserRow): FhirPractitioner {
  const resource: FhirPractitioner = {
    resourceType: "Practitioner",
    id: user.id,
    identifier: [
      {
        system: "urn:carebridge:users",
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
