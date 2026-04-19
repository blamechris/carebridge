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
 * Canonical UCUM codes we accept. UCUM is case-sensitive (`L` = liter,
 * `l` is not a case-sensitive UCUM atom), so the allowlist stores the
 * canonical casing and lookup happens through a lowercase index. Common
 * drug dosing units; not exhaustive for all of UCUM (which is several
 * thousand units including physical constants).
 *
 * When emitting the Quantity we return the canonical casing from this
 * list so external validators (Epic, Cerner, Inferno) accept the code,
 * while still accepting mixed-case user input (`MG`, `mL`, `mmol/l`).
 */
const UCUM_CANONICAL: readonly string[] = [
  // Mass
  "kg",
  "g",
  "mg",
  "ug",
  "ng",
  // Volume (note case: L is liter; l/dl/ml are also accepted UCUM atoms
  // but the case-sensitive canonical forms are the capital-L variants)
  "L",
  "mL",
  "dL",
  "uL",
  // Time
  "h",
  "min",
  "s",
  "d",
  "wk",
  "mo",
  "a",
  // Amount / electrolytes
  "meq",
  "mmol",
  "mol",
  // Derived dose units (per-weight, per-time, concentration)
  "mg/kg",
  "ug/kg",
  "g/kg",
  "mg/m2",
  "mg/min",
  "mg/h",
  "ug/h",
  "mg/mL",
  "g/dL",
  "mg/dL",
  "ng/mL",
  "pg/mL",
  "mmol/L",
];

/** Lowercase-indexed lookup to the canonical form. */
const UCUM_ALLOWLIST: Map<string, string> = new Map(
  UCUM_CANONICAL.map((c) => [c.toLowerCase(), c]),
);

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
  // (or the Unicode micro). Map to the canonical UCUM atom, for both the
  // bare form and common per-time compound.
  mcg: "ug",
  "mcg/h": "ug/h",
  "mcg/kg": "ug/kg",
  "mcg/min": "ug/min",
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

  // 1. Check the non-UCUM alias table first so that entries like
  //    `mcg` → `ug`, `mcg/h` → `ug/h` translate to canonical UCUM even
  //    when the legacy form happens to share a prefix with the allowlist.
  const annotation = NON_UCUM_TO_UCUM_CODE[normalised];
  if (annotation) {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: annotation,
    };
  }

  // 2. Look up against the canonical allowlist; emit with canonical casing.
  const canonical = UCUM_ALLOWLIST.get(normalised);
  if (canonical) {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: canonical,
    };
  }

  // 3. Unknown. Emit value + human-readable unit only — valid FHIR Quantity.
  return { value, unit };
}

/**
 * Predicate form, primarily for tests. Does not do the curly-brace mapping;
 * just answers whether the input is in the UCUM allowlist.
 */
export function isUcumAllowed(unit: string): boolean {
  return UCUM_ALLOWLIST.has(unit.trim().toLowerCase());
}
