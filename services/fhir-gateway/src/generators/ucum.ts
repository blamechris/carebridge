/**
 * UCUM validity helpers for FHIR Quantity emission (#946).
 *
 * Our internal `medications.dose_unit` is free-text. FHIR's Quantity shape
 * reserves `system: "http://unitsofmeasure.org"` for UCUM-coded units —
 * emitting a non-UCUM string under that system is a conformance violation.
 *
 * Strategy:
 *  - Known-UCUM tokens (mg, g, mL, L, mg/kg, IU variants, …) emit as a
 *    fully-coded Quantity (system + code + human-readable unit).
 *  - Known non-UCUM forms (tablet, puff, drop) emit the curly-brace
 *    annotation UCUM recognises ({tbl}, {puff}, {drop}).
 *  - Unknown strings emit a text-only Quantity (value + unit only) with
 *    no system / code — downstream validators accept that shape, whereas
 *    rejecting a UCUM system+code mismatch would mangle the resource.
 */

const UCUM_SYSTEM = "http://unitsofmeasure.org";

/**
 * Lowercase atomic/compound UCUM codes we accept verbatim. Common drug
 * dosing units; not exhaustive for all of UCUM (which is several thousand
 * units including physical constants).
 */
const UCUM_ALLOWLIST = new Set<string>([
  // Mass
  "kg",
  "g",
  "mg",
  "ug",
  "ng",
  // Volume
  "l",
  "ml",
  "dl",
  "ul",
  // Time
  "h",
  "min",
  "s",
  "d",
  "wk",
  "mo",
  "a",
  // Derived dose units (per-weight, per-time, concentration)
  "mg/kg",
  "ug/kg",
  "g/kg",
  "mg/m2",
  "mg/min",
  "mg/h",
  "mcg/h",
  "ug/h",
  "meq",
  "mmol",
  "mol",
  "mg/ml",
  "g/dl",
  "mmol/l",
]);

/**
 * Common non-UCUM unit strings → UCUM curly-brace annotation code.
 * UCUM permits annotations in curly braces for quantities that aren't
 * physical measurements (tablets, puffs, drops). Note IU → [iU] is the
 * official UCUM arbitrary-unit form.
 */
const NON_UCUM_TO_UCUM_CODE: Record<string, string> = {
  tablet: "{tbl}",
  tablets: "{tbl}",
  tab: "{tbl}",
  tabs: "{tbl}",
  capsule: "{cap}",
  capsules: "{cap}",
  cap: "{cap}",
  caps: "{cap}",
  puff: "{puff}",
  puffs: "{puff}",
  drop: "{drop}",
  drops: "{drop}",
  spray: "{spray}",
  sprays: "{spray}",
  patch: "{patch}",
  patches: "{patch}",
  iu: "[iU]",
  "international units": "[iU]",
  unit: "[iU]",
  units: "[iU]",
  u: "[iU]",
  // Clinical "mcg" is the legacy microgram form; strict UCUM uses "ug"
  // (or the Unicode micro). Map to the canonical UCUM atom.
  mcg: "ug",
};

export interface DoseQuantity {
  value: number;
  /** Human-readable unit (always the original input). */
  unit: string;
  /** UCUM system URL. Set only when `code` is valid UCUM. */
  system?: string;
  /** UCUM code. Set only when the input could be mapped to valid UCUM. */
  code?: string;
}

/**
 * Build a FHIR Quantity from an internal `{dose_amount, dose_unit}` pair.
 * Emits system + code only when the unit is valid UCUM (or we have a
 * well-known UCUM annotation for it). Unknown units produce a text-only
 * Quantity so downstream validators don't reject the resource.
 */
export function toDoseQuantity(value: number, unit: string): DoseQuantity {
  const normalised = unit.trim().toLowerCase();
  if (UCUM_ALLOWLIST.has(normalised)) {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: normalised,
    };
  }
  const annotation = NON_UCUM_TO_UCUM_CODE[normalised];
  if (annotation) {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: annotation,
    };
  }
  // Unknown. Emit value + human-readable unit only — valid FHIR Quantity.
  return { value, unit };
}

/**
 * Predicate form, primarily for tests. Does not do the curly-brace mapping;
 * just answers whether the input is in the UCUM allowlist.
 */
export function isUcumAllowed(unit: string): boolean {
  return UCUM_ALLOWLIST.has(unit.trim().toLowerCase());
}
