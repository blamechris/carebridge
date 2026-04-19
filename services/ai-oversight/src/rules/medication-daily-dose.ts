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
 * Map the excess-ratio of estimated-over-max into a flag severity.
 *
 * Opioids: the CDC 2022 guidance calibrates the per-drug daily caps in
 * MEDICATION_MAX_DAILY_DOSES to the 90 MME/day elevated-risk threshold.
 * Exceeding that cap by even 20% (1.2× → 108 MME) crosses into the zone
 * where respiratory-depression and overdose risk climbs steeply, so we
 * escalate to critical aggressively.
 *
 * Non-opioid NSAID / analgesic over-limits cause cumulative rather than
 * acute harm (hepatic, renal, GI), so 1–2× is warning, ≥2× is critical.
 */
function severityForDailyOver(
  ratio: number,
  isOpioid: boolean,
): FlagSeverity {
  if (isOpioid) return ratio >= 1.2 ? "critical" : "warning";
  return ratio >= 2.0 ? "critical" : "warning";
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

  const isOpioid = limit.mme_factor !== undefined;
  const slug = slugForRuleId(limit.display_name);

  // ── Per-dose over-max check ───────────────────────────────────
  // validateMedicationDose covers this when the writer supplies drugName;
  // mirror the check here so the AI layer catches the case even when the
  // writer didn't thread drugName through (most callers today).
  if (
    limit.max_single_dose_mg !== undefined &&
    med.dose_amount > limit.max_single_dose_mg
  ) {
    flags.push({
      severity: "critical",
      category: "medication-safety" as FlagCategory,
      summary:
        `"${med.name}" ${med.dose_amount} ${med.dose_unit ?? ""} single dose ` +
        `exceeds the ${limit.max_single_dose_mg} mg maximum for ${limit.display_name}`,
      rationale:
        `Per ${limit.source}, the maximum single oral dose of ${limit.display_name} ` +
        `is ${limit.max_single_dose_mg} mg. The prescribed single dose of ` +
        `${med.dose_amount} ${med.dose_unit ?? ""} exceeds this ceiling` +
        (isOpioid
          ? ". For opioids this raises the risk of respiratory depression."
          : "."),
      suggested_action:
        `Verify the prescribed dose. If the order is intentional (e.g. titrated ` +
        `for opioid-tolerant patient), document the justification. Otherwise ` +
        `reduce to ${limit.max_single_dose_mg} mg or below.`,
      notify_specialties: ["pharmacy"],
      rule_id: `MED-SINGLE-OVER-${slug.toUpperCase()}`,
    });
  }

  // ── Daily-cumulative over-max check ───────────────────────────
  if (
    daily !== null &&
    limit.max_daily_dose_mg !== undefined &&
    daily > limit.max_daily_dose_mg
  ) {
    const ratio = daily / limit.max_daily_dose_mg;
    const severity = severityForDailyOver(ratio, isOpioid);
    const mmeNote = isOpioid
      ? ` (implied ${Math.round(daily * (limit.mme_factor ?? 1))} MME/day; CDC elevated-risk threshold is 90 MME/day)`
      : "";
    flags.push({
      severity,
      category: "medication-safety" as FlagCategory,
      summary:
        `"${med.name}" at ${med.dose_amount} ${med.dose_unit ?? ""} ${med.frequency ?? ""} ` +
        `implies ~${Math.round(daily)} mg/day — exceeds ${limit.display_name} max ` +
        `(${limit.max_daily_dose_mg} mg/day)${mmeNote}`,
      rationale:
        `${limit.display_name} daily cap is ${limit.max_daily_dose_mg} mg ` +
        `(${limit.source}). The prescribed ${med.dose_amount} ${med.dose_unit ?? ""} ` +
        `${med.frequency ?? ""} translates to approximately ${Math.round(daily)} mg/day, ` +
        `which is ${ratio.toFixed(1)}× the ceiling. ` +
        (isOpioid
          ? `Over-prescription beyond the CDC 90 MME/day elevated-risk ` +
            `threshold is a leading driver of respiratory depression and overdose.`
          : `Chronic dosing above this threshold carries hepatic, renal, and ` +
            `GI risks depending on the agent.`),
      suggested_action:
        `Review frequency and dose. Typical options: reduce per-dose amount, ` +
        `widen dosing interval (e.g. q6h → q8h), or impose a PRN cap ` +
        `(max_doses_per_day) that bounds the daily total below ` +
        `${limit.max_daily_dose_mg} mg.`,
      notify_specialties: isOpioid ? ["pharmacy", "pain"] : ["pharmacy"],
      rule_id: `MED-DAILY-OVER-${slug.toUpperCase()}`,
    });
  }

  return flags;
}
