/**
 * Deterministic rule: check if a vital or lab value is in the critical range.
 *
 * This is the fastest layer of the oversight engine — no LLM, no network calls,
 * just boundary checks against known danger zones.
 */

import type { VitalType } from "@carebridge/shared-types";
import { COMMON_LAB_TESTS } from "@carebridge/shared-types";
import type { ClinicalEvent, FlagSeverity, FlagCategory, RuleFlag } from "@carebridge/shared-types";
import {
  DIASTOLIC_DANGER_ZONE,
  checkDiastolicBP,
  checkSystolicBP,
  getVitalRangeForAge,
  ageInYearsFromDOB,
} from "@carebridge/medical-logic";

// ─── Explicit Critical Lab Thresholds ────────────────────────────
// These thresholds fire deterministically on lab.resulted events,
// eliminating reliance on fragile heuristics for clinically dangerous values.

export interface LabThreshold {
  severity: FlagSeverity;
  direction: "low" | "high";
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

export interface LabCriticalDef {
  /** Canonical test names (case-insensitive match against test_name) */
  names: string[];
  /** LOINC codes to match against test_code */
  loinc_codes: string[];
  unit: string;
  evaluate: (value: number, context?: { medications?: string[] }) => LabThreshold | null;
}

export const CRITICAL_LAB_THRESHOLDS: Record<string, LabCriticalDef> = {
  "TROPONIN_I": {
    names: ["Troponin", "Troponin I", "cTnI", "Troponin-I"],
    loinc_codes: ["10839-9", "49563-0", "89579-7"],
    unit: "ng/mL",
    evaluate: (value) => {
      if (value > 0.4) {
        return {
          severity: "critical",
          direction: "high",
          summary: `Critical Troponin I: ${value} ng/mL (>0.4 — myocardial infarction range)`,
          rationale:
            `Troponin I of ${value} ng/mL significantly exceeds the MI threshold (>0.4 ng/mL). ` +
            `This level indicates substantial myocardial injury and requires emergent evaluation.`,
          suggested_action:
            "Obtain 12-lead ECG immediately. Activate ACS protocol if clinically indicated. " +
            "Repeat troponin in 3-6 hours. Cardiology consult urgently.",
          notify_specialties: ["cardiology", "emergency_medicine"],
        };
      }
      if (value > 0.04) {
        return {
          severity: "warning",
          direction: "high",
          summary: `Elevated Troponin I: ${value} ng/mL (>0.04 — above upper reference limit)`,
          rationale:
            `Troponin I of ${value} ng/mL exceeds the upper reference limit (0.04 ng/mL). ` +
            `This may indicate myocardial injury. Serial trending is recommended.`,
          suggested_action:
            "Obtain 12-lead ECG. Repeat troponin in 3-6 hours to assess trend. " +
            "Evaluate for ACS and non-ACS causes of troponin elevation.",
          notify_specialties: ["cardiology"],
        };
      }
      return null;
    },
  },

  "POTASSIUM": {
    names: ["Potassium", "K+", "K"],
    loinc_codes: ["2823-3", "6298-4"],
    unit: "mEq/L",
    evaluate: (value) => {
      if (value >= 6.0) {
        return {
          severity: "critical",
          direction: "high",
          summary: `Critical hyperkalemia: Potassium ${value} mEq/L (≥6.0 — cardiac arrest risk)`,
          rationale:
            `Potassium of ${value} mEq/L is critically elevated (≥6.0 mEq/L). ` +
            `Severe hyperkalemia carries immediate risk of fatal cardiac arrhythmias.`,
          suggested_action:
            "Obtain STAT 12-lead ECG. Initiate emergent hyperkalemia protocol: " +
            "IV calcium gluconate for cardiac membrane stabilization, insulin/dextrose, " +
            "and kayexalate or patiromer. Continuous telemetry monitoring.",
          notify_specialties: ["nephrology", "cardiology"],
        };
      }
      if (value >= 5.1) {
        return {
          severity: "warning",
          direction: "high",
          summary: `Elevated potassium: ${value} mEq/L (5.1–5.9 — monitor closely)`,
          rationale:
            `Potassium of ${value} mEq/L is above normal (>5.0 mEq/L). ` +
            `Moderate hyperkalemia warrants monitoring and potential intervention.`,
          suggested_action:
            "Verify specimen integrity (hemolysis check). Obtain ECG. " +
            "Review medications contributing to hyperkalemia (ACE inhibitors, ARBs, K-sparing diuretics). " +
            "Consider dietary potassium restriction.",
          notify_specialties: ["nephrology"],
        };
      }
      if (value < 3.0) {
        return {
          severity: "critical",
          direction: "low",
          summary: `Critical hypokalemia: Potassium ${value} mEq/L (<3.0 — cardiac arrest risk)`,
          rationale:
            `Potassium of ${value} mEq/L is critically low (<3.0 mEq/L). ` +
            `Severe hypokalemia carries risk of fatal cardiac arrhythmias and respiratory failure.`,
          suggested_action:
            "Initiate IV potassium replacement with continuous telemetry monitoring. " +
            "Check magnesium level (hypomagnesemia impairs potassium correction). " +
            "Obtain STAT ECG.",
          notify_specialties: ["nephrology", "cardiology"],
        };
      }
      if (value <= 3.4) {
        return {
          severity: "warning",
          direction: "low",
          summary: `Low potassium: ${value} mEq/L (3.0–3.4 — mild hypokalemia)`,
          rationale:
            `Potassium of ${value} mEq/L is below normal (3.0–3.4 mEq/L). ` +
            `Mild hypokalemia requires monitoring and oral replacement.`,
          suggested_action:
            "Oral potassium supplementation. Check magnesium level. " +
            "Review medications that may cause potassium loss (diuretics, laxatives).",
          notify_specialties: [],
        };
      }
      return null;
    },
  },

  "LACTATE": {
    names: ["Lactate", "Lactic Acid", "Lactic acid"],
    loinc_codes: ["2524-7", "32693-4"],
    unit: "mmol/L",
    evaluate: (value) => {
      if (value > 4.0) {
        return {
          severity: "critical",
          direction: "high",
          summary: `Critical lactate: ${value} mmol/L (>4.0 — severe sepsis/shock range)`,
          rationale:
            `Lactate of ${value} mmol/L is critically elevated (>4.0 mmol/L). ` +
            `This level is associated with severe tissue hypoperfusion, septic shock, ` +
            `or other causes of impaired oxygen delivery with high mortality risk.`,
          suggested_action:
            "Initiate aggressive fluid resuscitation per Surviving Sepsis guidelines. " +
            "Obtain blood cultures and initiate broad-spectrum antibiotics if sepsis suspected. " +
            "Evaluate for other causes of lactic acidosis. ICU consultation.",
          notify_specialties: ["critical_care", "infectious_disease"],
        };
      }
      if (value > 2.0) {
        return {
          severity: "warning",
          direction: "high",
          summary: `Elevated lactate: ${value} mmol/L (>2.0 — tissue hypoperfusion concern)`,
          rationale:
            `Lactate of ${value} mmol/L is above normal (>2.0 mmol/L). ` +
            `This may indicate early tissue hypoperfusion or increased anaerobic metabolism.`,
          suggested_action:
            "Assess volume status and perfusion. Consider fluid bolus. " +
            "Repeat lactate in 2-4 hours to assess trend. Evaluate for infectious source.",
          notify_specialties: [],
        };
      }
      return null;
    },
  },

  "PH_ARTERIAL": {
    names: ["pH", "pH (arterial)", "Arterial pH", "ABG pH", "Blood pH"],
    loinc_codes: ["2744-1", "2745-8"],
    unit: "",
    evaluate: (value) => {
      if (value > 7.55) {
        return {
          severity: "critical",
          direction: "high",
          summary: `Critical alkalemia: pH ${value} (>7.55 — severe alkalosis)`,
          rationale:
            `Arterial pH of ${value} is critically elevated (>7.55). ` +
            `Severe alkalosis can cause seizures, arrhythmias, and impaired oxygen delivery.`,
          suggested_action:
            "Obtain full ABG panel with electrolytes. Identify cause (respiratory vs metabolic). " +
            "For metabolic alkalosis: assess volume/chloride status. " +
            "For respiratory alkalosis: identify and treat underlying cause.",
          notify_specialties: ["critical_care", "pulmonology"],
        };
      }
      if (value > 7.45) {
        return {
          severity: "warning",
          direction: "high",
          summary: `Alkalemia: pH ${value} (7.45–7.55 — alkalosis)`,
          rationale:
            `Arterial pH of ${value} is above normal (>7.45). ` +
            `Alkalosis may indicate metabolic or respiratory disturbance.`,
          suggested_action:
            "Review full ABG and electrolytes. Identify and correct underlying cause.",
          notify_specialties: [],
        };
      }
      if (value < 7.25) {
        return {
          severity: "critical",
          direction: "low",
          summary: `Critical acidemia: pH ${value} (<7.25 — severe acidosis)`,
          rationale:
            `Arterial pH of ${value} is critically low (<7.25). ` +
            `Severe acidosis can cause cardiovascular collapse, impaired enzyme function, ` +
            `and multi-organ failure.`,
          suggested_action:
            "Obtain full ABG panel with electrolytes and anion gap. " +
            "For metabolic acidosis: calculate anion gap, check lactate, ketones. " +
            "Consider bicarbonate infusion if pH <7.1. ICU evaluation.",
          notify_specialties: ["critical_care", "nephrology"],
        };
      }
      if (value < 7.35) {
        return {
          severity: "warning",
          direction: "low",
          summary: `Acidemia: pH ${value} (7.25–7.34 — acidosis)`,
          rationale:
            `Arterial pH of ${value} is below normal (<7.35). ` +
            `Acidosis warrants evaluation for metabolic or respiratory cause.`,
          suggested_action:
            "Review full ABG and electrolytes. Calculate anion gap. " +
            "Identify and treat underlying cause of acidosis.",
          notify_specialties: [],
        };
      }
      return null;
    },
  },

  "INR": {
    names: ["INR", "International Normalized Ratio"],
    loinc_codes: ["6301-6", "34714-6"],
    unit: "",
    evaluate: (value, context) => {
      const onWarfarin = context?.medications?.some((med) =>
        /warfarin|coumadin/i.test(med)
      ) ?? false;

      if (value > 5.0) {
        return {
          severity: "critical",
          direction: "high",
          summary: `Critical INR: ${value} (>5.0 — hemorrhage risk)`,
          rationale:
            `INR of ${value} is critically elevated (>5.0). ` +
            `This level carries significant risk of spontaneous hemorrhage, ` +
            `including intracranial bleeding.`,
          suggested_action:
            "Hold warfarin/anticoagulant. Consider Vitamin K (phytonadione) administration. " +
            "For active bleeding or INR >9: consider fresh frozen plasma or 4-factor PCC. " +
            "Assess for signs of active bleeding.",
          notify_specialties: ["hematology"],
        };
      }
      if (value > 4.0) {
        return {
          severity: "warning",
          direction: "high",
          summary: `Elevated INR: ${value} (>4.0 — increased bleeding risk)`,
          rationale:
            `INR of ${value} is significantly elevated (>4.0). ` +
            `Supratherapeutic anticoagulation increases bleeding risk.`,
          suggested_action:
            "Hold next warfarin dose. Reassess warfarin dosing. " +
            "Check for drug interactions or dietary changes affecting INR. " +
            "Monitor for signs of bleeding.",
          notify_specialties: ["hematology"],
        };
      }
      if (onWarfarin && value < 1.5) {
        return {
          severity: "warning",
          direction: "low",
          summary: `Subtherapeutic INR: ${value} (<1.5 on warfarin — inadequate anticoagulation)`,
          rationale:
            `INR of ${value} is subtherapeutic (<1.5) in a patient on warfarin. ` +
            `Inadequate anticoagulation increases risk of thromboembolism.`,
          suggested_action:
            "Review warfarin dose and compliance. Consider bridging with LMWH " +
            "if high thrombotic risk. Reassess in 2-3 days after dose adjustment.",
          notify_specialties: [],
        };
      }
      return null;
    },
  },
};

/**
 * Normalize a test name for matching against critical threshold definitions.
 */
function matchesCriticalLab(
  testName: string,
  testCode: string | undefined,
  def: LabCriticalDef
): boolean {
  const normalizedName = testName.toLowerCase().trim();
  if (def.names.some((n) => n.toLowerCase() === normalizedName)) return true;
  if (testCode && def.loinc_codes.includes(testCode)) return true;
  return false;
}

export type { RuleFlag };

export function checkCriticalValues(event: ClinicalEvent): RuleFlag[] {
  const flags: RuleFlag[] = [];

  // Compute patient age from DOB when available (supports pediatric thresholds)
  const patientDOB = event.data.patient_date_of_birth as string | undefined;
  const patientAgeYears = ageInYearsFromDOB(patientDOB);

  if (event.type === "vital.created") {
    const vitalType = event.data.type as VitalType | undefined;
    const value = event.data.value_primary as number | undefined;

    // Blood pressure is handled separately by checkSystolicBP / checkDiastolicBP below.
    if (vitalType && vitalType !== "blood_pressure" && value !== undefined) {
      const range = getVitalRangeForAge(vitalType, patientAgeYears);

      let severity: "critical" | "warning" | null = null;
      if (range.criticalLow !== undefined && value <= range.criticalLow) severity = "critical";
      else if (range.criticalHigh !== undefined && value >= range.criticalHigh) severity = "critical";
      else if (range.warningLow !== undefined && value < range.warningLow) severity = "warning";
      else if (range.warningHigh !== undefined && value > range.warningHigh) severity = "warning";

      if (severity) {
        const isLow =
          (range.criticalLow !== undefined && value <= range.criticalLow) ||
          (range.warningLow !== undefined && value < range.warningLow);
        const direction = isLow ? "low" : "high";
        const severityLabel = severity === "critical" ? "Critically" : "";
        const summaryPrefix = severity === "critical"
          ? `Critically ${direction}`
          : direction === "low" ? "Low" : "High";

        flags.push({
          severity,
          category: "critical-value",
          summary: `${summaryPrefix} ${vitalType.replace(/_/g, " ")}: ${value} ${(event.data.unit as string) ?? ""}`.trim(),
          rationale:
            severity === "critical"
              ? `Patient's ${vitalType.replace(/_/g, " ")} of ${value} is in the critical range. ` +
                `Normal critical thresholds: ${range.criticalLow !== undefined ? `low <= ${range.criticalLow}` : ""}` +
                `${range.criticalLow !== undefined && range.criticalHigh !== undefined ? ", " : ""}` +
                `${range.criticalHigh !== undefined ? `high >= ${range.criticalHigh}` : ""}. ` +
                `Immediate clinical assessment is recommended.`
              : `Patient's ${vitalType.replace(/_/g, " ")} of ${value} is outside normal range. ` +
                `Warning thresholds: ${range.warningLow !== undefined ? `low < ${range.warningLow}` : ""}` +
                `${range.warningLow !== undefined && range.warningHigh !== undefined ? ", " : ""}` +
                `${range.warningHigh !== undefined ? `high > ${range.warningHigh}` : ""}. ` +
                `Clinical review is recommended.`,
          suggested_action:
            severity === "critical"
              ? direction === "low"
                ? `Assess patient immediately. Evaluate for causes of critically low ${vitalType.replace(/_/g, " ")} and initiate appropriate intervention.`
                : `Assess patient immediately. Evaluate for causes of critically elevated ${vitalType.replace(/_/g, " ")} and initiate appropriate intervention.`
              : `Review ${vitalType.replace(/_/g, " ")} trend and assess patient. Consider repeat measurement and clinical correlation.`,
          notify_specialties: [],
          rule_id: `CRITICAL-VITAL-${vitalType.toUpperCase()}`,
        });
      }
    }

    // Evaluate systolic BP (critical + warning) independently for blood pressure vitals
    if (vitalType === "blood_pressure" && value !== undefined) {
      const systolicSeverity = checkSystolicBP(value);
      if (systolicSeverity) {
        const range = getVitalRangeForAge("blood_pressure", patientAgeYears);
        const isLow = range.criticalLow !== undefined && value <= (range.warningLow ?? range.criticalLow);
        const direction = isLow ? "low" : "high";
        flags.push({
          severity: systolicSeverity,
          category: "critical-value",
          summary: systolicSeverity === "critical"
            ? `Critically ${direction} systolic blood pressure: ${value} ${(event.data.unit as string) ?? "mmHg"}`.trim()
            : `Low systolic blood pressure: ${value} ${(event.data.unit as string) ?? "mmHg"}`.trim(),
          rationale: systolicSeverity === "critical"
            ? `Patient's systolic blood pressure of ${value} mmHg is in the critical range. ` +
              `Immediate clinical assessment is recommended.`
            : `Patient's systolic blood pressure of ${value} mmHg is below ${range.warningLow} mmHg, ` +
              `indicating symptomatic hypotension. SBP in this range may cause dizziness, syncope, ` +
              `and inadequate organ perfusion. Clinical evaluation is recommended.`,
          suggested_action: systolicSeverity === "critical"
            ? `Assess patient immediately. Evaluate for causes of critically ${direction} ` +
              `systolic blood pressure and initiate appropriate intervention.`
            : `Assess patient for symptoms of hypotension (dizziness, lightheadedness, syncope). ` +
              `Review medications that may contribute to hypotension (antihypertensives, diuretics). ` +
              `Consider IV fluid bolus if symptomatic. Monitor closely for further decline.`,
          notify_specialties: systolicSeverity === "critical" ? ["cardiology", "critical_care"] : [],
          rule_id: systolicSeverity === "critical" ? `CRITICAL-VITAL-BLOOD_PRESSURE` : `WARNING-VITAL-SYSTOLIC_BP`,
        });
      }
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
      test_code?: string;
      value: number;
      unit: string;
      reference_low?: number;
      reference_high?: number;
      flag?: string;
    }> | undefined;

    const medications = event.data.active_medications as string[] | undefined;

    if (results && Array.isArray(results)) {
      for (const result of results) {
        // ── 1. Explicit critical thresholds (highest priority) ────────
        let matchedExplicit = false;
        for (const [ruleKey, def] of Object.entries(CRITICAL_LAB_THRESHOLDS)) {
          if (matchesCriticalLab(result.test_name, result.test_code, def)) {
            const threshold = def.evaluate(result.value, { medications });
            if (threshold) {
              matchedExplicit = true;
              flags.push({
                severity: threshold.severity,
                category: "critical-value",
                summary: threshold.summary,
                rationale: threshold.rationale,
                suggested_action: threshold.suggested_action,
                notify_specialties: threshold.notify_specialties,
                rule_id: `CRITICAL-LAB-${ruleKey}`,
              });
            }
            break; // Only match the first matching definition
          }
        }

        // ── 2. Heuristic fallback for labs without explicit thresholds ─
        if (!matchedExplicit) {
          // The analyzing laboratory's flag is authoritative. If a lab
          // reports `flag: "critical" | "H" | "L"`, we emit a flag
          // regardless of whether the result carries a reference range
          // and regardless of whether the test is in COMMON_LAB_TESTS.
          // Previously, unknown labs with no reference range could slip
          // through silently when the lab had already marked them high /
          // low / critical (see issue #244).
          let severity: FlagSeverity | null = null;
          let direction: "low" | "high" | null = null;
          let reason = "";

          if (result.flag === "critical") {
            severity = "critical";
            // Use per-result reference range when present to infer direction;
            // otherwise default to "high" (most lab-panel critical flags are
            // elevations; direction is refined below if we can compute it).
            direction =
              result.reference_low !== undefined &&
              result.value < result.reference_low
                ? "low"
                : "high";
            reason = `Lab result flagged as critical by the analyzing laboratory.`;
          } else if (result.flag === "H") {
            severity = "warning";
            direction = "high";
            reason = `Lab result flagged as high (H) by the analyzing laboratory.`;
          } else if (result.flag === "L") {
            severity = "warning";
            direction = "low";
            reason = `Lab result flagged as low (L) by the analyzing laboratory.`;
          }

          // Per-result reference range is authoritative over COMMON_LAB_TESTS.
          // Only use the shared typical range as a fallback when the result
          // does not carry its own reference_low / reference_high.
          if (severity === null) {
            if (
              result.reference_low !== undefined &&
              result.reference_high !== undefined
            ) {
              const range = result.reference_high - result.reference_low;
              if (
                result.value < result.reference_low - range ||
                result.value > result.reference_high + range
              ) {
                severity = "critical";
                direction =
                  result.value < result.reference_low ? "low" : "high";
                reason =
                  `Value of ${result.value} ${result.unit} is far outside reference range ` +
                  `(${result.reference_low}–${result.reference_high} ${result.unit}).`;
              }
            } else if (
              result.reference_low === undefined &&
              result.reference_high === undefined
            ) {
              // Fallback: check against COMMON_LAB_TESTS for known tests
              // without explicit references.
              const ref = COMMON_LAB_TESTS[result.test_name];
              if (ref) {
                const range = ref.typical_high - ref.typical_low;
                if (
                  result.value < ref.typical_low - range ||
                  result.value > ref.typical_high + range
                ) {
                  severity = "critical";
                  direction = result.value < ref.typical_low ? "low" : "high";
                  reason =
                    `Value of ${result.value} ${result.unit} is far outside typical range ` +
                    `(${ref.typical_low}–${ref.typical_high} ${ref.unit}).`;
                }
              }
            }
          }

          if (severity !== null) {
            const resolvedDirection = direction ?? "high";
            const summaryPrefix =
              severity === "critical"
                ? "Critical lab result"
                : resolvedDirection === "high"
                  ? "High lab result"
                  : "Low lab result";

            flags.push({
              severity,
              category: "critical-value",
              summary: `${summaryPrefix}: ${result.test_name} = ${result.value} ${result.unit}`,
              rationale: reason,
              suggested_action:
                severity === "critical"
                  ? `Review critical ${result.test_name} result immediately. Correlate with clinical status and consider repeat testing or intervention.`
                  : `Review ${resolvedDirection} ${result.test_name} result. Correlate with clinical status and trend; repeat testing as indicated.`,
              notify_specialties: [],
              rule_id: `${severity === "critical" ? "CRITICAL" : "WARNING"}-LAB-${result.test_name.replace(/\s+/g, "_").toUpperCase()}`,
            });
          }
        }
      }
    }
  }

  return flags;
}
