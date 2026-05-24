/**
 * Shape validators for the optional clinician identifier columns on the
 * users table (#947, #1150). Both helpers are pure functions so they can
 * be safely called from the Practitioner generator and from any
 * future admin-tool validation surface (ops backfill scripts, write-side
 * Zod schemas).
 *
 * Why the generator needs these (#1150)
 * -------------------------------------
 * The Practitioner generator stamps `meta.profile = us-core-practitioner`
 * when BOTH `npi` and `nucc_code` are present — a downstream conformance
 * claim that validators (Inferno, Touchstone, HAPI) will exercise. A
 * malformed value from an ops backfill (typo, off-by-one digit, swapped
 * letter) would sail through the existence check and produce a *false*
 * conformance claim, which is worse than emitting no profile at all.
 *
 * Defense in depth
 * ----------------
 * 1. DB CHECK constraint (`0053_npi_nucc_check.sql`) enforces the regex
 *    shape — Postgres cannot do Luhn without a plpgsql function, so this
 *    catches typos at write time but not all bad values.
 * 2. These helpers run app-side and additionally enforce the Luhn
 *    check-digit on NPI. They are what the generator and write-side
 *    admin code should call before committing a value.
 *
 * Spec references
 * ---------------
 * - CMS NPI check-digit algorithm (modified Luhn with "80840" CMS
 *   prefix): https://www.cms.gov/Regulations-and-Guidance/Administrative-Simplification/NationalProvIdentStand/Downloads/NPIcheckdigit.pdf
 * - NUCC Health Care Provider Taxonomy: https://taxonomy.nucc.org/
 *   Provider taxonomy codes are 10 characters: 5 chars from a defined
 *   alphabet + literal "0000" + a single trailing letter (commonly "X").
 */

/** CMS prefix used by the NPI check-digit algorithm. Not part of the NPI itself. */
const NPI_CMS_PREFIX = "80840";

/**
 * NPI shape: must be EXACTLY 10 digits, no separators, no whitespace.
 * Leading zeros are valid for the column but reject placeholder values
 * via the all-zeros guard in `isValidNpi`.
 */
const NPI_SHAPE = /^[0-9]{10}$/;

/**
 * NUCC taxonomy code shape: 5 alphanumeric chars + literal "0000" + a
 * single trailing letter. The full canonical list is maintained at
 * https://taxonomy.nucc.org/ and is too large / too volatile to bundle
 * locally; we validate shape only and let the operator-driven backfill
 * own correctness of the mapping.
 *
 * Case-sensitive: canonical NUCC codes are uppercase, and downstream
 * validators (Inferno / Touchstone / HAPI) compare exact case against
 * the registered code system. Accepting lowercase here would let a
 * malformed value pass the app gate, then be emitted lowercase to the
 * Practitioner resource — a false `meta.profile` claim. The DB CHECK
 * constraint in `0053_npi_nucc_check.sql` mirrors this by using the
 * case-sensitive `~` POSIX operator with `[A-Z0-9]` / `[A-Z]`.
 */
const NUCC_SHAPE = /^[A-Z0-9]{5}0000[A-Z]$/;

/**
 * True when `npi` is exactly 10 digits AND passes the CMS NPI
 * check-digit algorithm (modified Luhn over the CMS-prefixed string).
 *
 * Steps (per the CMS PDF):
 * 1. Reject anything that isn't 10 digits.
 * 2. Reject the all-zeros placeholder (passes Luhn arithmetic but is
 *    never a real NPI and frequently appears in unfilled rows).
 * 3. Prepend "80840" (CMS prefix) to the 10-digit NPI.
 * 4. Apply standard Luhn over the 15-char prefixed string: starting
 *    from the rightmost digit, double every second digit; sum every
 *    digit of the doubled values plus the un-doubled digits.
 * 5. Total mod 10 must be 0.
 */
export function isValidNpi(npi: string): boolean {
  if (!NPI_SHAPE.test(npi)) return false;
  if (npi === "0000000000") return false;

  const prefixed = `${NPI_CMS_PREFIX}${npi}`; // 15 chars total
  let sum = 0;
  // Walk right-to-left so the rightmost digit is position 1 (un-doubled),
  // and every second digit going left is doubled. This matches the CMS
  // PDF worked example exactly.
  for (let i = prefixed.length - 1, pos = 1; i >= 0; i--, pos++) {
    const digit = prefixed.charCodeAt(i) - 48; // '0'.charCodeAt(0) === 48
    if (pos % 2 === 0) {
      const doubled = digit * 2;
      // Sum the digits of the doubled value (max 18 → 1+8 == 9, hence
      // either the doubled value itself or doubled-9).
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return sum % 10 === 0;
}

/**
 * True when `code` matches the NUCC provider-taxonomy shape:
 *   5 chars from [A-Z0-9] + literal "0000" + 1 letter [A-Z]
 *
 * We deliberately do NOT validate against the canonical NUCC list —
 * shape alone is enough to catch typos / off-by-one swaps from an ops
 * backfill, and maintaining a local copy of the canonical list would
 * rot quickly (NUCC publishes updates twice yearly).
 */
export function isValidNuccCode(code: string): boolean {
  return NUCC_SHAPE.test(code);
}
