/**
 * UCUM validity helpers for FHIR Quantity emission (#946, #978).
 *
 * Our internal `medications.dose_unit` is free-text. FHIR's Quantity shape
 * reserves `system: "http://unitsofmeasure.org"` for UCUM-coded units —
 * emitting a non-UCUM string under that system is a conformance violation.
 *
 * Strategy (post-#978):
 *  1. Clinical-context alias table first (`mcg → ug`, `IU → [iU]`, `MG → mg`,
 *     `tablet → {tbl}`). UCUM is strictly case-sensitive — `MG` is megaGauss
 *     and `mcg` isn't a UCUM atom — but clinicians type these freely. The
 *     alias table normalises the common clinical legacy forms to canonical
 *     UCUM (or curly-brace annotations) before any validator call.
 *  2. Validation via @lhncbc/ucum-lhc (the NIH/NLM reference implementation)
 *     for anything that survives the alias step. The validator accepts the
 *     full UCUM grammar — exponent / product forms like `10*6/uL` and
 *     `mg.kg-1.d-1` that the pre-#978 hand-curated allowlist rejected.
 *  3. Text-only Quantity fallback for anything neither table nor validator
 *     can resolve — preserves the value + human-readable unit without
 *     emitting an invalid system+code pair.
 *
 * Policy on validator strictness:
 *  We require `status === "valid"` from `validateUnitString`. The library
 *  also returns `ucumCode` for confusable-but-invalid inputs (e.g. `IU` →
 *  `[IU]` with status=invalid), but we never broaden on invalid status —
 *  invalid inputs that need a canonical mapping must live in the alias
 *  table, where the mapping is explicit and reviewable.
 *
 * Bundle impact: `@lhncbc/ucum-lhc` is ~500KB compressed / ~2MB unpacked,
 * acceptable for a backend service. The utils instance is memoised at
 * module scope so the ~500KB unit-definition JSON loads once per process.
 */

// The package ships CJS with no type declarations; declare the surface we
// use locally rather than pulling in an untyped `any` import.
// @ts-expect-error -- no @types/lhncbc__ucum-lhc package exists
import pkg from "@lhncbc/ucum-lhc";

interface ValidateResult {
  status: "valid" | "invalid" | "error";
  ucumCode: string | null;
  msg?: string[];
}

interface UcumLhcUtilsLike {
  validateUnitString(input: string, suggest: boolean): ValidateResult;
}

interface UcumLhcUtilsCtor {
  getInstance(): UcumLhcUtilsLike;
}

const { UcumLhcUtils } = pkg as { UcumLhcUtils: UcumLhcUtilsCtor };

const UCUM_SYSTEM = "http://unitsofmeasure.org";

/**
 * Common non-UCUM (or case-confusable) clinical inputs → canonical UCUM.
 *
 * Kept after #978 because:
 *  - Curly-brace annotations (`{tbl}`, `{puff}`, `{drop}`, `{spray}`,
 *    `{patch}`, `{cap}`) are valid UCUM, but the validator would never
 *    accept the bare english word (`tablet`, `puff`, …) — we have to map
 *    those explicitly.
 *  - `mcg`, `mcg/h`, `mcg/kg`, `mcg/min` are legacy clinical forms that
 *    aren't strict UCUM; we canonicalise to `ug…`.
 *  - `IU`, `Unit`, `units`, `U` (when meant as international units rather
 *    than the UCUM enzyme unit) map to `[iU]`.
 *  - Lowercase `ml`, `l`, `dl` are valid UCUM atoms BUT case-sensitive
 *    UCUM canonicalises to `mL`, `L`, `dL` — Epic/Cerner/Inferno expect
 *    the uppercase L form, so we coerce here.
 *  - `MG` is megaGauss in strict UCUM; in clinical context it always
 *    means milligrams, so we coerce.
 */
// Use `Object.assign(Object.create(null), …)` so the lookup table has no
// prototype chain. `medications.dose_unit` is free-text from clinician
// input — a plain-object lookup with bracket access would resolve keys
// like `__proto__` / `constructor` via `Object.prototype`, returning the
// prototype object / Object constructor function and emitting them as
// the FHIR `code` field. A null-prototype object eliminates that class
// of bug entirely; lookups for non-own keys return `undefined`.
const NON_UCUM_TO_UCUM_CODE: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    // Tablet / dose-form annotations
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
    // International-unit forms — clinicians type IU/Unit/units; UCUM is [iU]
    iu: "[iU]",
    "international units": "[iU]",
    unit: "[iU]",
    units: "[iU]",
    u: "[iU]",
    // Clinical "mcg" → canonical UCUM "ug" (microgram)
    mcg: "ug",
    "mcg/h": "ug/h",
    "mcg/kg": "ug/kg",
    "mcg/min": "ug/min",
    // Case-canonicalisation: lowercase forms → case-sensitive UCUM canonical
    ml: "mL",
    l: "L",
    dl: "dL",
    ul: "uL",
    "mmol/l": "mmol/L",
    "mg/dl": "mg/dL",
    "ng/ml": "ng/mL",
    "pg/ml": "pg/mL",
    "g/dl": "g/dL",
    "mg/ml": "mg/mL",
    // 'MG' (megaGauss in strict UCUM) → milligrams in clinical context
    mg: "mg",
  },
);

/**
 * Lazy-loaded singleton UcumLhcUtils. The constructor populates a ~500KB
 * unit-definitions table; we memoise so repeated `toDoseQuantity` calls
 * pay the cost only once per process.
 */
let utilsSingleton: UcumLhcUtilsLike | null = null;
function getUtils(): UcumLhcUtilsLike {
  if (utilsSingleton === null) {
    utilsSingleton = UcumLhcUtils.getInstance();
  }
  return utilsSingleton;
}

/**
 * Per-process memo of validator results keyed by raw input. A bulk FHIR
 * export over a patient's medication history sees the same handful of
 * unit strings (`mg`, `mg/kg`, `mL`, …) repeated across many resources;
 * caching the validator's verdict avoids re-parsing each call against
 * the ~3.5k-entry unit table. Stores both hits (canonical code) and
 * misses (`null`) so invalid inputs are also short-circuited on retry.
 *
 * Bounded to a reasonable size to defend against memory growth from a
 * pathological caller pumping unique unit strings; UCUM-valid forms in
 * clinical use number in the low hundreds, so a 1024-entry ceiling is
 * comfortably above the working set.
 */
const VALIDATOR_CACHE_MAX = 1024;
const validatorCache: Map<string, string | null> = new Map();

/**
 * Run the validator without leaking its stderr-noisy "blank spaces are
 * not allowed" / "please specify a unit" error paths. Returns the
 * canonical UCUM code on success, null otherwise.
 */
function validateViaLhc(input: string): string | null {
  // Guard cases where the library prints to stderr / throws.
  if (input.length === 0 || /\s/.test(input)) {
    return null;
  }
  const cached = validatorCache.get(input);
  if (cached !== undefined || validatorCache.has(input)) {
    return cached ?? null;
  }
  let result: string | null;
  try {
    const r = getUtils().validateUnitString(input, false);
    result =
      r.status === "valid" && typeof r.ucumCode === "string" ? r.ucumCode : null;
  } catch {
    result = null;
  }
  // Evict the oldest entry on overflow — Map iteration is insertion-ordered,
  // so the first key returned by `keys()` is the longest-resident entry.
  if (validatorCache.size >= VALIDATOR_CACHE_MAX) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(input, result);
  return result;
}

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
 *
 * Emits system + code only when the unit resolves to valid UCUM (via the
 * alias table or the UCUM-lhc validator). Unknown units produce a
 * text-only Quantity so downstream validators don't reject the resource.
 *
 * The `unit` field always carries the original input string so the
 * clinician-readable rendering is preserved even after canonicalisation.
 */
export function toDoseQuantity(value: number, unit: string): DoseQuantity {
  const trimmed = unit.trim();
  const lower = trimmed.toLowerCase();

  // 1. Alias table first. Catches `mcg`, `IU`, `tablet`, `MG`, and the
  //    lowercase volume forms (`ml` → `mL`). The table is null-prototype,
  //    so bracket access cannot resolve inherited keys like `__proto__`;
  //    the `typeof === "string"` guard is belt-and-suspenders for any
  //    future refactor that swaps the table back to a plain object.
  const aliased = NON_UCUM_TO_UCUM_CODE[lower];
  if (typeof aliased === "string") {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: aliased,
    };
  }

  // 2. Validate the raw input via UCUM-lhc. Accepts the full UCUM grammar
  //    (e.g. `10*6/uL`, `mg.kg-1.d-1`, `[iU]/mL`).
  const ucumCode = validateViaLhc(trimmed);
  if (ucumCode !== null) {
    return {
      value,
      unit,
      system: UCUM_SYSTEM,
      code: ucumCode,
    };
  }

  // 3. Unknown. Emit value + human-readable unit only — valid FHIR Quantity.
  return { value, unit };
}

/**
 * Predicate form, primarily for tests. Returns true when the input is a
 * valid UCUM expression — either directly (per the lhc validator) or
 * after the alias table maps it to a canonical UCUM code.
 *
 * Does NOT match curly-brace annotation aliases (e.g. `tablet` → `{tbl}`):
 * the callers using this predicate want strict UCUM membership, and the
 * curly-brace forms are a presentation concern handled inside
 * `toDoseQuantity`.
 */
export function isUcumAllowed(unit: string): boolean {
  const trimmed = unit.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();

  // Alias-table hit, but only if the mapped target is a real UCUM code
  // (not a curly-brace annotation that the validator would also accept).
  // `typeof === "string"` defends against the prototype-pollution class
  // of bug — see the matching comment in `toDoseQuantity`.
  const aliased = NON_UCUM_TO_UCUM_CODE[lower];
  if (typeof aliased === "string") {
    if (aliased.startsWith("{")) return false;
    return validateViaLhc(aliased) !== null;
  }

  return validateViaLhc(trimmed) !== null;
}
