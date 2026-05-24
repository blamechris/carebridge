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
import type {
  FhirPractitioner,
  HumanName,
  Identifier,
  PractitionerQualification,
} from "../types/fhir-r4.js";
import { CAREBRIDGE_IDENTIFIER_BASE } from "./identifiers.js";
import { isValidNpi, isValidNuccCode } from "./practitioner-validation.js";
import { US_CORE_PRACTITIONER } from "./us-core-profiles.js";

/**
 * Registered identifier system for the US National Provider Identifier
 * (#947). This is the canonical URL that US Core Practitioner expects
 * for the primary clinician identifier; using anything else (including
 * our locally-scoped CareBridge namespace) does NOT satisfy the
 * profile's identifier slice.
 */
export const US_NPI_IDENTIFIER_SYSTEM = "http://hl7.org/fhir/sid/us-npi";

/**
 * Registered code system for the NUCC Health Care Provider Taxonomy
 * (#947). When a user row has a `nucc_code` populated, the generator
 * attaches a coding to `qualification.code` so downstream consumers can
 * map specialties without parsing the free-text `specialty` column.
 */
export const NUCC_TAXONOMY_SYSTEM = "http://nucc.org/provider-taxonomy";

// Re-exported for backward compatibility with consumers that imported
// CAREBRIDGE_IDENTIFIER_BASE from this module before #969 lifted the
// constant into identifiers.ts. New consumers should import directly
// from "./identifiers.js" or via the generators barrel.
export { CAREBRIDGE_IDENTIFIER_BASE };

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
 * Heuristic for ≥3-token names
 * ----------------------------
 * 1. If the penultimate token is a bare initial ("M" or "M."), treat the
 *    name as Anglo `First Middle Last` — family is the last token, given
 *    captures everything else.
 * 2. Otherwise the penultimate is assumed to be the first half of a
 *    two-part family (Hispanic / Portuguese pattern). This means
 *    `María García López` → family=`García López`, given=`[María]`.
 * 3. Particles (de, del, van, von, der, bin, ibn, …) immediately before
 *    the family group are absorbed into family so `Sarah de Klerk` →
 *    family=`de Klerk` and `Jan van der Berg` → family=`van der Berg`.
 *
 * Known tradeoff (#974, #1027)
 * ----------------------------
 * Anglo full-middle-name inputs like `Sarah Marie Jones` parse as
 * family=`Marie Jones`, given=`[Sarah]` — because we have no signal at
 * this layer to tell a middle-name from a Hispanic first-half-of-family.
 * The bare-initial guard above keeps `Sarah M. Jones` working, but
 * spelled-out middle names regress.
 *
 * The same applies to longer Anglo chains — whenever the penultimate
 * token is not a bare initial, it is absorbed into family regardless of
 * token count. So `John Robert Quincy Adams` parses as family=`Quincy
 * Adams`, given=`[John, Robert]`. This is not a 3-token-only quirk.
 *
 * Long-term fix is the structured `name_family` / `name_given[]` columns
 * on the users table tracked in #972; until then, the test suite pins
 * representative cases so a future edit cannot silently flip behaviour.
 *
 * Hyphenated surnames (`Smith-Jones`) stay as one token and need no
 * special handling.
 *
 * This is a heuristic; structured name fields on the users table are the
 * long-term fix (see #972 for the migration plan).
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

/**
 * Build the FHIR HumanName from a user row, preferring the authoritative
 * structured columns (#972) when populated. Falls back to the parseName
 * heuristic over the free-text `name` column for rows that haven't been
 * backfilled yet.
 *
 * The structured path is exact — no guessing about Hispanic two-part
 * surnames vs middle names, no particle-absorption heuristics. Writers
 * have already classified the name correctly.
 */
function buildPractitionerName(user: UserRow): HumanName {
  if (user.name_family) {
    const name: HumanName = {
      text: user.name,
      family: user.name_family,
    };
    if (user.name_given && user.name_given.length > 0) {
      name.given = user.name_given;
    }
    if (user.name_prefix) {
      name.prefix = [user.name_prefix];
    }
    if (user.name_suffix) {
      name.suffix = [user.name_suffix];
    }
    return name;
  }
  // Fallback: heuristic parse of the free-text `name` column. Removed
  // once the backfill completes and the structured columns flip to NOT
  // NULL — see #972.
  return parseName(user.name);
}

export function toFhirPractitioner(user: UserRow): FhirPractitioner {
  // Shape-validate the optional clinician identifier columns before any
  // FHIR emission decision (#1150). The DB CHECK constraints in
  // `0053_npi_nucc_check.sql` already enforce the regex shape, but the
  // NPI Luhn check-digit cannot be expressed in plain SQL, so the
  // app-layer remains the authoritative gate. An invalid value still
  // sits in the column (it shouldn't, post-0053, but historic rows or
  // any future shape-bypass would land here); we degrade gracefully
  // rather than emitting a malformed identifier.
  const npiIsValid = user.npi !== null && isValidNpi(user.npi);
  const nuccIsValid = user.nucc_code !== null && isValidNuccCode(user.nucc_code);

  // US Core Practitioner identifier slice (#947): when the user row
  // carries a SHAPE-VALID NPI we emit it first with the registered
  // `us-npi` system so the primary identifier satisfies the profile.
  // The existing internal `/user-id` identifier stays as a secondary
  // entry so local lookups (audit join, internal references) keep
  // working. A column value that fails shape validation is silently
  // dropped from `identifier[]` — see #1150 for the rationale (false
  // conformance > omitted conformance).
  const identifier: Identifier[] = [];
  if (npiIsValid) {
    identifier.push({
      system: US_NPI_IDENTIFIER_SYSTEM,
      value: user.npi!,
    });
  }
  identifier.push({
    system: `${CAREBRIDGE_IDENTIFIER_BASE}/user-id`,
    value: user.id,
  });

  // Qualification / specialty. If the row has a SHAPE-VALID NUCC
  // taxonomy code we attach a `coding` alongside the free-text
  // specialty so consumers can map specialties without parsing English.
  // Without a valid NUCC code we keep the legacy text-only shape —
  // emitting an unverified code is worse for interop than emitting
  // none.
  let qualification: PractitionerQualification[] | undefined;
  if (user.specialty || nuccIsValid) {
    const code: PractitionerQualification["code"] = {};
    if (user.specialty) {
      code.text = user.specialty;
    }
    if (nuccIsValid) {
      code.coding = [
        {
          system: NUCC_TAXONOMY_SYSTEM,
          code: user.nucc_code!,
        },
      ];
    }
    qualification = [{ code }];
  }

  const resource: FhirPractitioner = {
    resourceType: "Practitioner",
    id: user.id,
    identifier,
    name: [buildPractitionerName(user)],
  };

  // US Core Practitioner conformance gate (#947, tightened by #1150).
  //
  // The profile requires at least one identifier with a registered
  // system AND SHOULD carry a NUCC qualification coding. We declare
  // `meta.profile` only when BOTH signals are present AND shape-valid
  // on the row — emitting it without valid values would be a false
  // conformance claim that downstream validators would flag.
  //
  // Rows with missing OR malformed signals continue to emit the
  // pre-#947 shape: no meta.profile, internal-namespace identifier,
  // text-only qualification. That keeps existing consumers and the
  // unbackfilled-row case backward compatible.
  if (npiIsValid && nuccIsValid) {
    resource.meta = {
      profile: [US_CORE_PRACTITIONER],
    };
  }

  if (qualification) {
    resource.qualification = qualification;
  }

  return resource;
}
