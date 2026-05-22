/**
 * Medication daily-cumulative dose rule (issue #235).
 *
 * Fires on medication.created / medication.updated events. Parses the
 * newly-prescribed medication's frequency string, computes the implied
 * doses-per-24h, multiplies by dose_amount, and compares the result to
 * the per-drug max from `MEDICATION_MAX_DAILY_DOSES` (issue #238).
 *
 * The canonical example this prevents: "Morphine 10 mg Q2H PRN" — a
 * clinician writes the frequency as unstructured text, the prescription
 * writer enforces only single-dose limits, and the implied 120 mg/day
 * (well above the 90 mg/day MME-calibrated cap) sails through. This rule
 * closes that gap.
 *
 * Rule ID prefix scheme (aligned with existing lab/contraindication rules):
 *   - `MED-DAILY-OVER-*`   — estimated daily > drug's max_daily_dose_mg
 *   - `MED-SINGLE-OVER-*`  — per-dose exceeds drug's max_single_dose_mg
 *                            (covers the case validateMedicationDose missed
 *                             because the writer never supplied drugName)
 *
 * Fail-open: unparseable frequency strings, unknown drugs, and missing
 * dose_amount produce no flag. High-risk inputs still get the per-dose
 * check from validateMedicationDose upstream.
 */

import type {
  FlagSeverity,
  FlagCategory,
  RuleFlag,
} from "@carebridge/shared-types";
import {
  parseFrequencyText,
  estimateDailyDose,
  getMedicationDoseLimit,
} from "@carebridge/medical-logic";
import type { PatientContext, PatientMedication } from "./cross-specialty.js";
import { createLogger } from "@carebridge/logger";

const log = createLogger("medication-daily-dose");

/**
 * Canonicalise a drug name into a rule_id slug: lowercase, replace
 * non-alphanumerics with underscore, collapse repeats. Keeps rule_ids
 * stable across alias variants (Tylenol vs acetaminophen both resolve to
 * the same generic name via getMedicationDoseLimit, but we use the
 * resolved display name to build the slug so both produce the same id).
 */
function slugForRuleId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]+\)\s*/g, "") // drop "(PO)" etc.
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Default critical-escalation ratios. The opioid default (1.2×) is
 * CDC-calibrated against the 2022 90 MME/day threshold; the non-opioid
 * default (2.0×) reflects cumulative hepatic/renal/GI harm — not a CDC
 * threshold (CDC's 90 MME guideline is opioid-only). Active values are
 * exported as {@link OPIOID_CRITICAL_RATIO} / {@link NON_OPIOID_CRITICAL_RATIO}
 * below and may be tuned per-deployment via env vars (see
 * {@link resolveRatio}).
 */
export const OPIOID_CRITICAL_RATIO_DEFAULT = 1.2;
export const NON_OPIOID_CRITICAL_RATIO_DEFAULT = 2.0;

/**
 * Strict numeric pattern: positive decimal, no sign, no trailing junk,
 * no commas. Rejects partials that Number.parseFloat would silently
 * accept like "2.0x" → 2.0 or "2,0" → 2 (#1043).
 */
const STRICT_NUMERIC = /^\d+(?:\.\d+)?$/;

/**
 * Resolve a per-deployment ratio override from an env var. Returns the
 * default when the env var is unset, empty, fails strict numeric parsing,
 * or is ≤ 1.0 (a ratio of 1.0 or below would fire critical on any
 * over-cap dose at all, collapsing the warning band and almost certainly
 * a misconfiguration).
 *
 * Strict numeric parsing rejects partial matches that Number.parseFloat
 * would accept silently: "2.0x" (typo), "2,0" (locale typo), "1e3"
 * (scientific notation — unusual for a human-set ratio), "+1.5" (sign
 * prefix). Any of these surface as `invalid_ratio_override` rather than
 * a silently de-tuned safety guard (#1043).
 *
 * Invalid values fall back to the default with a structured warning so
 * the operator can see the misconfiguration in CI / startup logs without
 * the safety guard silently de-tuning to nothing.
 */
export function resolveRatio(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultValue;
  const trimmed = raw.trim();
  if (!STRICT_NUMERIC.test(trimmed)) {
    log.warn("invalid_ratio_override", {
      envKey,
      raw,
      reason: "not a strict decimal literal",
      fallback: defaultValue,
    });
    return defaultValue;
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 1.0) {
    log.warn("invalid_ratio_override", {
      envKey,
      raw,
      reason: "non-finite or ≤ 1.0",
      fallback: defaultValue,
    });
    return defaultValue;
  }
  return parsed;
}

/**
 * Opioid daily-dose excess-ratio at which we escalate warning → critical.
 *
 * Default (1.2×) is calibrated against the CDC 2022 90 MME/day elevated-
 * risk threshold — per-drug daily caps in MEDICATION_MAX_DAILY_DOSES are
 * pegged to 90 MME, so 1.2× → 108 MME, the zone where respiratory-
 * depression and overdose risk climb steeply.
 *
 * Override via `OPIOID_CRITICAL_RATIO` env var. Different care settings
 * have legitimate calibration needs:
 *  - Hospice / palliative: CDC exempts active cancer / sickle-cell /
 *    end-of-life from the 90 MME threshold. Raise to 2.0+ to avoid
 *    flooding the flag queue with expected-and-appropriate prescriptions.
 *  - Outpatient / primary care: 1.2× is CDC's target — keep default.
 *  - Inpatient acute / post-op: short-horizon higher doses are routine;
 *    consider 1.5–1.8×.
 *
 * When the override differs from the default, the active value is
 * surfaced in the flag rationale so reviewers see which threshold fired.
 */
export const OPIOID_CRITICAL_RATIO = resolveRatio(
  "OPIOID_CRITICAL_RATIO",
  OPIOID_CRITICAL_RATIO_DEFAULT,
);

/**
 * Non-opioid NSAID / analgesic over-limits cause cumulative rather than
 * acute harm (hepatic, renal, GI over weeks of over-dosing), so the
 * default is a gentler 2.0× gradient: 1–2× is warning, ≥2× is critical.
 *
 * Override via `NON_OPIOID_CRITICAL_RATIO` env var (e.g. hepatic-clinic
 * deployments may want 1.5× given Child-Pugh-B patients' diminished
 * tolerance). Same fallback / audit-rationale visibility as the opioid
 * ratio above.
 */
export const NON_OPIOID_CRITICAL_RATIO = resolveRatio(
  "NON_OPIOID_CRITICAL_RATIO",
  NON_OPIOID_CRITICAL_RATIO_DEFAULT,
);

/** Per-deployment override active? */
function isOpioidRatioOverridden(): boolean {
  return OPIOID_CRITICAL_RATIO !== OPIOID_CRITICAL_RATIO_DEFAULT;
}
function isNonOpioidRatioOverridden(): boolean {
  return NON_OPIOID_CRITICAL_RATIO !== NON_OPIOID_CRITICAL_RATIO_DEFAULT;
}

/** Map the excess-ratio of estimated-over-max into a flag severity. */
function severityForDailyOver(
  ratio: number,
  isOpioid: boolean,
): FlagSeverity {
  const critThreshold = isOpioid
    ? OPIOID_CRITICAL_RATIO
    : NON_OPIOID_CRITICAL_RATIO;
  return ratio >= critThreshold ? "critical" : "warning";
}

export function checkMedicationDailyDose(context: PatientContext): RuleFlag[] {
  const flags: RuleFlag[] = [];

  const triggerType = context.trigger_event?.type;
  if (
    triggerType !== "medication.created" &&
    triggerType !== "medication.updated"
  ) {
    return flags;
  }

  const details = context.active_medications_detail;
  if (!details || details.length === 0) return flags;

  // Find the triggering medication by resourceId. Falls back to name+status
  // if no resourceId (older event payloads). Unknown → bail.
  const triggerResourceId = context.trigger_event?.data?.resourceId as
    | string
    | undefined;
  const triggerName = context.trigger_event?.data?.name as string | undefined;

  let med: PatientMedication | undefined;
  if (triggerResourceId) {
    med = details.find((m) => m.id === triggerResourceId);
  }
  if (!med && triggerName) {
    const triggerLower = triggerName.toLowerCase();
    med = details.find((m) => m.name.toLowerCase() === triggerLower);
  }
  if (!med) return flags;

  if (med.dose_amount == null) return flags;
  // Per-drug ceilings are expressed in mg. Skip non-mg prescriptions
  // (mcg patches, mL infusions) — a future issue will add unit conversion.
  const unit = (med.dose_unit ?? "").toLowerCase();
  if (unit !== "mg") return flags;

  const limit = getMedicationDoseLimit(med.name);
  if (!limit) return flags;

  const freq = parseFrequencyText(med.frequency);
  const daily = estimateDailyDose(
    med.dose_amount,
    freq,
    med.max_doses_per_day ?? null,
  );

  const isOpioid = limit.mmeFactor !== undefined;
  const slug = slugForRuleId(limit.displayName);

  // ── Per-dose over-max check ───────────────────────────────────
  // validateMedicationDose covers this when the writer supplies drugName;
  // mirror the check here so the AI layer catches the case even when the
  // writer didn't thread drugName through (most callers today).
  if (
    limit.maxSingleDoseMg !== undefined &&
    med.dose_amount > limit.maxSingleDoseMg
  ) {
    flags.push({
      severity: "critical",
      category: "medication-safety" as FlagCategory,
      summary:
        `"${med.name}" ${med.dose_amount} ${med.dose_unit ?? ""} single dose ` +
        `exceeds the ${limit.maxSingleDoseMg} mg maximum for ${limit.displayName}`,
      rationale:
        `Per ${limit.source}, the maximum single oral dose of ${limit.displayName} ` +
        `is ${limit.maxSingleDoseMg} mg. The prescribed single dose of ` +
        `${med.dose_amount} ${med.dose_unit ?? ""} exceeds this ceiling` +
        (isOpioid
          ? ". For opioids this raises the risk of respiratory depression."
          : "."),
      suggested_action:
        `Verify the prescribed dose. If the order is intentional (e.g. titrated ` +
        `for opioid-tolerant patient), document the justification. Otherwise ` +
        `reduce to ${limit.maxSingleDoseMg} mg or below.`,
      notify_specialties: ["pharmacy"],
      rule_id: `MED-SINGLE-OVER-${slug.toUpperCase()}`,
    });
  }

  // ── Daily-cumulative over-max check ───────────────────────────
  if (
    daily !== null &&
    limit.maxDailyDoseMg !== undefined &&
    daily > limit.maxDailyDoseMg
  ) {
    const ratio = daily / limit.maxDailyDoseMg;
    const severity = severityForDailyOver(ratio, isOpioid);
    const mmeNote = isOpioid
      ? ` (implied ${Math.round(daily * (limit.mmeFactor ?? 1))} MME/day; CDC elevated-risk threshold is 90 MME/day)`
      : "";
    // Surface the active critical-escalation ratio in the audit trail
    // when it has been overridden via env config so reviewers can see
    // which threshold fired (#968).
    const activeRatio = isOpioid ? OPIOID_CRITICAL_RATIO : NON_OPIOID_CRITICAL_RATIO;
    const isOverridden = isOpioid
      ? isOpioidRatioOverridden()
      : isNonOpioidRatioOverridden();
    // The opioid default (1.2×) is CDC-calibrated; the non-opioid default
    // (2.0×) comes from the cumulative-harm rationale (hepatic / renal /
    // GI over weeks) — not the CDC 90 MME guideline. Label them correctly
    // so the audit trail doesn't falsely credit CDC for the non-opioid
    // threshold (#1042).
    const defaultRatio = isOpioid
      ? OPIOID_CRITICAL_RATIO_DEFAULT
      : NON_OPIOID_CRITICAL_RATIO_DEFAULT;
    const defaultSource = isOpioid ? "CDC default" : "cumulative-harm default";
    const overrideNote = isOverridden
      ? ` Active critical-escalation ratio: ${activeRatio}× (deployment override; ${defaultSource} ${defaultRatio}×).`
      : "";
    flags.push({
      severity,
      category: "medication-safety" as FlagCategory,
      summary:
        `"${med.name}" at ${med.dose_amount} ${med.dose_unit ?? ""} ${med.frequency ?? ""} ` +
        `implies ~${Math.round(daily)} mg/day — exceeds ${limit.displayName} max ` +
        `(${limit.maxDailyDoseMg} mg/day)${mmeNote}`,
      rationale:
        `${limit.displayName} daily cap is ${limit.maxDailyDoseMg} mg ` +
        `(${limit.source}). The prescribed ${med.dose_amount} ${med.dose_unit ?? ""} ` +
        `${med.frequency ?? ""} translates to approximately ${Math.round(daily)} mg/day, ` +
        `which is ${ratio.toFixed(1)}× the ceiling. ` +
        (isOpioid
          ? `Over-prescription beyond the CDC 90 MME/day elevated-risk ` +
            `threshold is a leading driver of respiratory depression and overdose.`
          : `Chronic dosing above this threshold carries hepatic, renal, and ` +
            `GI risks depending on the agent.`) +
        overrideNote,
      suggested_action:
        `Review frequency and dose. Typical options: reduce per-dose amount, ` +
        `widen dosing interval (e.g. q6h → q8h), or impose a PRN cap ` +
        `(max_doses_per_day) that bounds the daily total below ` +
        `${limit.maxDailyDoseMg} mg.`,
      notify_specialties: isOpioid ? ["pharmacy", "pain_management"] : ["pharmacy"],
      rule_id: `MED-DAILY-OVER-${slug.toUpperCase()}`,
    });
  }

  return flags;
}
