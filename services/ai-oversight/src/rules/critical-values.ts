/**
 * Deterministic rule: check if a vital or lab value is in the critical range.
 *
 * This is the fastest layer of the oversight engine — no LLM, no network calls,
 * just boundary checks against known danger zones.
 */

import type { VitalType } from "@carebridge/shared-types";
import { COMMON_LAB_TESTS } from "@carebridge/shared-types";
import type { ClinicalEvent, FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import { VITAL_DANGER_ZONES, DIASTOLIC_DANGER_ZONE, isCriticalVital, checkDiastolicBP } from "@carebridge/medical-logic";

export interface RuleFlag {
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
  rule_id: string;
}

export function checkCriticalValues(event: ClinicalEvent): RuleFlag[] {
  const flags: RuleFlag[] = [];

  if (event.type === "vital.created") {
    const vitalType = event.data.type as VitalType | undefined;
    const value = event.data.value_primary as number | undefined;

    if (vitalType && value !== undefined && isCriticalVital(vitalType, value)) {
      const range = VITAL_DANGER_ZONES[vitalType];
      const direction =
        range.criticalLow !== undefined && value <= range.criticalLow
          ? "low"
          : "high";

      flags.push({
        severity: "critical",
        category: "critical-value",
        summary: `Critically ${direction} ${vitalType.replace(/_/g, " ")}: ${value} ${(event.data.unit as string) ?? ""}`.trim(),
        rationale:
          `Patient's ${vitalType.replace(/_/g, " ")} of ${value} is in the critical range. ` +
          `Normal critical thresholds: ${range.criticalLow !== undefined ? `low <= ${range.criticalLow}` : ""}` +
          `${range.criticalLow !== undefined && range.criticalHigh !== undefined ? ", " : ""}` +
          `${range.criticalHigh !== undefined ? `high >= ${range.criticalHigh}` : ""}. ` +
          `Immediate clinical assessment is recommended.`,
        suggested_action:
          direction === "low"
            ? `Assess patient immediately. Evaluate for causes of critically low ${vitalType.replace(/_/g, " ")} and initiate appropriate intervention.`
            : `Assess patient immediately. Evaluate for causes of critically elevated ${vitalType.replace(/_/g, " ")} and initiate appropriate intervention.`,
        notify_specialties: [],
        rule_id: `CRITICAL-VITAL-${vitalType.toUpperCase()}`,
      });
    }

    // Evaluate diastolic BP independently for blood pressure vitals
    if (vitalType === "blood_pressure") {
      const diastolic = event.data.value_secondary as number | undefined;
      if (diastolic !== undefined) {
        const diastolicSeverity = checkDiastolicBP(diastolic);
        if (diastolicSeverity) {
          const direction = diastolic < DIASTOLIC_DANGER_ZONE.criticalLow ? "low" : "high";
          const displayBP = value !== undefined ? `${value}/${diastolic}` : `${diastolic}`;
          flags.push({
            severity: diastolicSeverity,
            category: "critical-value",
            summary: `Critically ${direction} diastolic blood pressure: ${displayBP} ${(event.data.unit as string) ?? "mmHg"}`.trim(),
            rationale:
              `Patient's diastolic blood pressure of ${diastolic} mmHg is in the ${diastolicSeverity} range. ` +
              `Diastolic thresholds: critical low < ${DIASTOLIC_DANGER_ZONE.criticalLow}, ` +
              `warning high >= ${DIASTOLIC_DANGER_ZONE.warningHigh}, ` +
              `critical high >= ${DIASTOLIC_DANGER_ZONE.criticalHigh}. ` +
              (diastolicSeverity === "critical" && direction === "high"
                ? `Diastolic >= ${DIASTOLIC_DANGER_ZONE.criticalHigh} mmHg indicates hypertensive emergency. Immediate assessment required.`
                : diastolicSeverity === "critical" && direction === "low"
                  ? `Diastolic < ${DIASTOLIC_DANGER_ZONE.criticalLow} mmHg indicates significant hypotension. Immediate assessment required.`
                  : `Diastolic >= ${DIASTOLIC_DANGER_ZONE.warningHigh} mmHg indicates hypertension requiring clinical evaluation.`),
            suggested_action:
              diastolicSeverity === "critical"
                ? `Assess patient immediately. ${direction === "high" ? "Evaluate for hypertensive emergency — risk of stroke, aortic dissection, and end-organ damage. Initiate IV antihypertensive therapy per protocol." : "Evaluate for causes of hypotension and initiate fluid resuscitation or vasopressor support as indicated."}`
                : `Evaluate patient for hypertension. Consider repeat measurement, medication review, and initiation or adjustment of antihypertensive therapy.`,
            notify_specialties: diastolicSeverity === "critical" ? ["cardiology"] : [],
            rule_id: `CRITICAL-VITAL-DIASTOLIC_BP`,
          });
        }
      }
    }
  }

  if (event.type === "lab.resulted") {
    const results = event.data.results as Array<{
      test_name: string;
      value: number;
      unit: string;
      reference_low?: number;
      reference_high?: number;
      flag?: string;
    }> | undefined;

    if (results && Array.isArray(results)) {
      for (const result of results) {
        let isCritical = false;
        let reason = "";

        // Check explicit critical flag
        if (result.flag === "critical") {
          isCritical = true;
          reason = `Lab result flagged as critical by the analyzing laboratory.`;
        }

        // Check if value is far outside reference range (more than 2x the range deviation)
        if (
          !isCritical &&
          result.reference_low !== undefined &&
          result.reference_high !== undefined
        ) {
          const range = result.reference_high - result.reference_low;
          if (
            result.value < result.reference_low - range ||
            result.value > result.reference_high + range
          ) {
            isCritical = true;
            reason =
              `Value of ${result.value} ${result.unit} is far outside reference range ` +
              `(${result.reference_low}–${result.reference_high} ${result.unit}).`;
          }
        }

        // Fallback: check against COMMON_LAB_TESTS for known tests without explicit references
        if (!isCritical && result.reference_low === undefined) {
          const ref = COMMON_LAB_TESTS[result.test_name];
          if (ref) {
            const range = ref.typical_high - ref.typical_low;
            if (
              result.value < ref.typical_low - range ||
              result.value > ref.typical_high + range
            ) {
              isCritical = true;
              reason =
                `Value of ${result.value} ${result.unit} is far outside typical range ` +
                `(${ref.typical_low}–${ref.typical_high} ${ref.unit}).`;
            }
          }
        }

        if (isCritical) {
          const direction =
            result.reference_low !== undefined &&
            result.value < result.reference_low
              ? "low"
              : "high";

          flags.push({
            severity: "critical",
            category: "critical-value",
            summary: `Critical lab result: ${result.test_name} = ${result.value} ${result.unit}`,
            rationale: reason,
            suggested_action: `Review critical ${result.test_name} result immediately. Correlate with clinical status and consider repeat testing or intervention.`,
            notify_specialties: [],
            rule_id: `CRITICAL-LAB-${result.test_name.replace(/\s+/g, "_").toUpperCase()}`,
          });
        }
      }
    }
  }

  return flags;
}
