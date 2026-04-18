/**
 * Unit-aware accessors for rule-level `recent_labs` (issue #856).
 *
 * The rule-level `PatientContext.recent_labs` entries carry a `unit` string
 * that originates from `lab_results.unit` in the database. Deterministic
 * rules compare lab values against numeric thresholds that are defined in a
 * specific canonical unit per analyte (e.g. K+ < 3.5 mEq/L). When the
 * recorded unit does not match the canonical set for a given analyte, the
 * rule MUST refuse to compare the raw number against its threshold —
 * otherwise a 120 mg/dL glucose reading could be silently compared against
 * a 6.7 mmol/L threshold and produce a false positive (or negative).
 *
 * Normalization policy (conservative):
 *   - Only 1:1 numeric aliases are accepted as "equivalent" here
 *     (e.g. mEq/L ↔ mmol/L for monovalent ions like K+, Na+, Cl−).
 *   - Anything that requires molar-mass conversion (mg/dL ↔ mmol/L for
 *     glucose, creatinine, etc.) must NOT be aliased — that's a real
 *     conversion and a separate implementation.
 *   - Unknown / empty units fail closed: the helper returns undefined and
 *     emits a structured warn so the observability pipeline surfaces the
 *     gap.
 */

import { createLogger } from "@carebridge/logger";
import type { PatientContext } from "./cross-specialty.js";

const logger = createLogger("ai-oversight");

/** A recent_labs entry with a non-optional unit string. */
export interface RecentLab {
  name: string;
  value: number;
  /** Unit string as recorded in the EHR; empty string means unknown. */
  unit: string;
}

/**
 * Canonical / accepted units for individual analytes that rules compare
 * against threshold values. Kept deliberately small — adding an entry here
 * is a clinical safety decision that should be reviewed per-analyte.
 *
 * Keys are lower-cased, trimmed unit strings. Presence in the set means
 * "numerically equivalent to the canonical unit for this analyte".
 */
const POTASSIUM_ACCEPTED_UNITS: ReadonlySet<string> = new Set([
  "meq/l",
  "mmol/l",
]);

const SODIUM_ACCEPTED_UNITS: ReadonlySet<string> = new Set([
  "meq/l",
  "mmol/l",
]);

const CHLORIDE_ACCEPTED_UNITS: ReadonlySet<string> = new Set([
  "meq/l",
  "mmol/l",
]);

/**
 * eGFR is reported as mL/min/1.73m² (BSA-indexed MDRD / CKD-EPI) in the
 * U.S. and often written with various spacing / encoding variants. All
 * listed values are the BSA-indexed estimated GFR — only formatting
 * variance is tolerated here.
 *
 * Raw "mL/min" (unindexed Cockcroft-Gault creatinine clearance) is
 * DELIBERATELY NOT accepted: it is not numerically equivalent to the
 * BSA-indexed value used by the FDA metformin contraindication threshold
 * (<30 mL/min/1.73m²) and can diverge 20–30% in non-average-BSA patients.
 * Aliasing the two would defeat the whole point of the unit-check
 * infrastructure for CROSS-METFORMIN-GFR-001. Labs recorded as raw
 * "mL/min" must fail closed (rule_lab_unit_mismatch) so the gap is
 * surfaced rather than silently compared.
 */
const EGFR_ACCEPTED_UNITS: ReadonlySet<string> = new Set([
  "ml/min/1.73m2",
  "ml/min/1.73m²",
  "ml/min/1.73 m2",
  "ml/min/1.73 m²",
]);

/** Normalize a unit string for set-lookup: trim, lowercase. */
function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

/**
 * Find the most-recent lab in `ctx.recent_labs` whose name matches
 * `namePattern` AND whose unit is in `acceptedUnits`. Returns undefined
 * when no such lab is present.
 *
 * Labs with an unknown or mismatched unit are skipped with a structured
 * warn, so the gap is observable in logs/metrics without silently
 * comparing wrong-unit values.
 *
 * @param ctx           The rule-level patient context.
 * @param namePattern   Regex matched case-insensitively against the lab name.
 * @param acceptedUnits Set of lower-cased, trimmed unit strings that are
 *                      numerically equivalent for this analyte.
 * @param analyte       Short analyte tag for log correlation (e.g. "K+").
 */
export function findRecentLab(
  ctx: PatientContext,
  namePattern: RegExp,
  acceptedUnits: ReadonlySet<string>,
  analyte: string,
): RecentLab | undefined {
  const labs = ctx.recent_labs;
  if (!labs || labs.length === 0) return undefined;

  for (const lab of labs) {
    if (!namePattern.test(lab.name.trim())) continue;
    const normalized = normalizeUnit(lab.unit);
    if (normalized === "") {
      logger.warn("rule_lab_unit_missing", {
        metric: "rule_lab_unit_missing",
        analyte,
        lab_name: lab.name,
        caller: "rules:findRecentLab",
      });
      continue;
    }
    if (!acceptedUnits.has(normalized)) {
      logger.warn("rule_lab_unit_mismatch", {
        metric: "rule_lab_unit_mismatch",
        analyte,
        lab_name: lab.name,
        lab_unit: lab.unit,
        accepted_units: Array.from(acceptedUnits),
        caller: "rules:findRecentLab",
      });
      continue;
    }
    return { name: lab.name, value: lab.value, unit: lab.unit };
  }
  return undefined;
}

/**
 * Find the most-recent potassium (K+) value in recent_labs where the unit
 * is numerically equivalent to mEq/L. For monovalent ions, mEq/L and
 * mmol/L are 1:1 equivalent and both are accepted.
 *
 * Returns undefined when no K+ result is present, the unit is missing, or
 * the unit is not in the accepted list (e.g. mg/dL — nonsensical for K+
 * and almost certainly a data-entry or import error).
 */
export function getRecentPotassium(ctx: PatientContext): RecentLab | undefined {
  // Name match: "Potassium", "K", or "K+". Anchored so we don't match
  // unrelated labs that merely contain "K".
  const NAME = /^(potassium|k\+?)$/i;
  return findRecentLab(ctx, NAME, POTASSIUM_ACCEPTED_UNITS, "K+");
}

/**
 * Find the most-recent sodium (Na+) value with accepted unit.
 */
export function getRecentSodium(ctx: PatientContext): RecentLab | undefined {
  const NAME = /^(sodium|na\+?)$/i;
  return findRecentLab(ctx, NAME, SODIUM_ACCEPTED_UNITS, "Na+");
}

/**
 * Find the most-recent chloride (Cl−) value with accepted unit.
 */
export function getRecentChloride(ctx: PatientContext): RecentLab | undefined {
  const NAME = /^(chloride|cl-?)$/i;
  return findRecentLab(ctx, NAME, CHLORIDE_ACCEPTED_UNITS, "Cl-");
}

/**
 * Find the most-recent eGFR value with accepted unit (BSA-indexed
 * mL/min/1.73m² or spacing/encoding-tolerant variants). Raw "mL/min"
 * (unindexed Cockcroft-Gault CrCl) is NOT accepted — see
 * EGFR_ACCEPTED_UNITS for rationale.
 */
export function getRecentEGFR(ctx: PatientContext): RecentLab | undefined {
  // Issue #873: anchored alias set tolerant to whitespace and optional "e"
  // prefix. Matches "GFR", "eGFR", "egfr", "Estimated GFR", "Estimated  GFR".
  // Rejects distinct labs that merely embed GFR as a substring
  // (e.g. "Pre-GFR Calc", "GFR Calculator").
  const NAME = /^(e?gfr|estimated\s+gfr)$/i;
  return findRecentLab(ctx, NAME, EGFR_ACCEPTED_UNITS, "eGFR");
}
