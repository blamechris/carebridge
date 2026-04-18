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
import { createLogger } from "@carebridge/logger";

const logger = createLogger("ai-oversight");

/**
 * Common HL7v2 abnormal-flag values we promote to deterministic severities.
 *
 * HL7v2 precedent: single-letter `H` / `L` means "out-of-reference-range
 * high/low"; double-letter `HH` / `LL` means "panic high/low" — the lab's
 * explicit panic-threshold signal, which is a strictly stronger claim than
 * `H` / `L`. Issue #853 revisited the original PR #842 mapping (which
 * compressed `HH` / `LL` to warning) and concluded that panic flags should
 * map to `critical` to match HL7v2 semantics.
 *
 *   - HH → critical, direction=high   (panic-high)
 *   - LL → critical, direction=low    (panic-low)
 *
 * Promoting to `critical` also sidesteps the severity-ceiling concern
 * flagged in issue #849: because the numeric range-check branch below is
 * gated on `severity === null`, a lower-than-critical mapping here would
 * pre-empt a potentially-critical range-deviation signal. Critical is the
 * top severity, so no downstream suppression is possible.
 *
 * Single-letter `H` / `L` remain as warnings (unchanged from PR #842).
 * Other common HL7v2 values (A, AA, N, U, '' etc.) remain unmapped and fall
 * through to the range checks; a structured warn is emitted so operators can
 * observe silent drops.
 */
const HL7_FLAG_MAPPINGS: Record<
  string,
  { severity: FlagSeverity; direction: "low" | "high" }
> = {
  HH: { severity: "critical", direction: "high" },
  LL: { severity: "critical", direction: "low" },
};

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
 * Build a lab rule_id whose prefix reflects the flag severity.
 *
 * Issue #836: prior to this harmonization the explicit-threshold path
 * hard-coded a `CRITICAL-LAB-*` prefix regardless of the threshold's
 * actual severity (e.g. Troponin I 0.04–0.4 ng/mL was a "warning"
 * severity but emitted `CRITICAL-LAB-TROPONIN_I`). The heuristic
 * fallback path already varied the prefix by severity, producing
 * inconsistent semantics for downstream consumers that filter on
 * rule_id prefix. Centralizing the prefix construction here keeps the
 * mapping in one place and guarantees `severity` and `rule_id` agree.
 *
 * Mapping:
 *   - severity="critical" → `CRITICAL-LAB-${ruleKey}`
 *   - severity="warning"  → `WARNING-LAB-${ruleKey}`
 *   - severity="info"     → `INFO-LAB-${ruleKey}`
 */
function buildLabRuleId(severity: FlagSeverity, ruleKey: string): string {
  return `${severity.toUpperCase()}-LAB-${ruleKey}`;
}

/**
 * Coarse "any-analyte-implausible" numeric sanity window for the issue
 * #835 unevaluated-lab fallback.
 *
 * Issue #867 (reviewer follow-up on PR #860): when the unevaluable
 * fallback fires, the info-severity default is plausibly under-alerting
 * for values whose magnitude alone suggests data corruption or a
 * decimal / sign / unit error. Without a reference range or canonical
 * mapping we cannot claim a clinical threshold, but we CAN observe that
 * common human-scale analyte results almost never fall outside
 * (0.01, 10000) in their own units. Values outside that window are much
 * more likely to be clinician-review-worthy than values inside it.
 *
 * Chosen thresholds (signal-over-noise hints, NOT clinical thresholds):
 *   - value > 10000  → extreme magnitude (misordered units / order-of-
 *     magnitude error). Most physiological analytes rarely exceed a few
 *     thousand in their reported units.
 *   - value < 0.01   → near-zero or sub-thresholdable (decimal misplacement
 *     or lost precision). For positive analytes this usually means the
 *     reading is either missing or encoded with the wrong multiplier.
 *   - value < 0      → negative concentrations / counts are almost always
 *     data errors; captured by `value < 0.01` above (negatives satisfy
 *     the same predicate).
 *
 * Escalation stays at `warning` (not `critical`) because the signal is
 * magnitude-based, not analyte-specific: `critical` requires a clinical
 * claim we cannot make without a reference. The escalation is additive —
 * the base case (value in the window) continues to emit info.
 */
const EXTREME_VALUE_HIGH = 10000;
const EXTREME_VALUE_LOW = 0.01;

function isExtremeNumericValue(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return value > EXTREME_VALUE_HIGH || value < EXTREME_VALUE_LOW;
}

/**
 * Infer the direction ("low" | "high") of a laboratory-flagged critical
 * result when the lab itself did not encode direction in the flag string.
 *
 * Issue #833: the previous implementation only consulted `reference_low`
 * and defaulted to `"high"` whenever `reference_low` was missing, even when
 * the value was clearly below `reference_high`. That misdirected clinician
 * notifications ("Critical high" when the value was panic-low) and eroded
 * trust in the deterministic layer.
 *
 * Inference strategy, in order:
 *   1. If both bounds are present, direction is determined by the midpoint:
 *      values below the midpoint are "low", values above are "high".
 *      The midpoint is a principled neutral answer for edge cases where
 *      a value sits inside the reference range but the lab has flagged it
 *      as critical (e.g. CKD-adjusted baselines).
 *   2. If only `reference_high` is present, values below it are "low",
 *      otherwise "high".
 *   3. If only `reference_low` is present, values below it are "low",
 *      otherwise "high".
 *   4. If no bounds are present, default to "high" (documented fallback;
 *      most laboratory-flagged critical results are elevations).
 */
function inferCriticalDirection(
  value: number,
  referenceLow: number | undefined,
  referenceHigh: number | undefined,
): "low" | "high" {
  if (referenceLow !== undefined && referenceHigh !== undefined) {
    const midpoint = (referenceLow + referenceHigh) / 2;
    return value < midpoint ? "low" : "high";
  }
  if (referenceHigh !== undefined) {
    return value < referenceHigh ? "low" : "high";
  }
  if (referenceLow !== undefined) {
    return value < referenceLow ? "low" : "high";
  }
  return "high";
}

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
        // Track whether the test name matched an explicit threshold
        // definition at all (even when `evaluate` returned null for a normal
        // value). Labs that match an explicit def were evaluated and must
        // not trip the issue #835 "unable-to-evaluate" fallback below.
        let matchedExplicitDef = false;
        for (const [ruleKey, def] of Object.entries(CRITICAL_LAB_THRESHOLDS)) {
          if (matchesCriticalLab(result.test_name, result.test_code, def)) {
            matchedExplicitDef = true;
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
                rule_id: buildLabRuleId(threshold.severity, ruleKey),
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
          //
          // Issue #834: non-null `flag` values outside the validator enum
          // (e.g. HL7v2 "HH", "LL", "abnormal", "A", empty string) can
          // reach this function through ingress paths that skip the Zod
          // validator (FHIR, HL7v2, direct DB seeding). We now (a) emit a
          // structured warning so silent drops of explicit lab-marked
          // abnormalities are observable, and (b) map common HL7v2
          // panic flags conservatively to warnings so a panic-low lab
          // does not silently fall through to range checks alone.
          let severity: FlagSeverity | null = null;
          let direction: "low" | "high" | null = null;
          let reason = "";

          if (result.flag === "critical") {
            severity = "critical";
            // Infer direction from whatever reference bound is present.
            // Issue #833: previously, an undefined `reference_low` forced
            // `direction = "high"` even when the value was clearly below
            // `reference_high`. Now we also check `reference_high`, and
            // use the midpoint when both bounds are present. Default
            // fallback remains `"high"` when no bounds are provided.
            direction = inferCriticalDirection(
              result.value,
              result.reference_low,
              result.reference_high,
            );
            reason = `Lab result flagged as critical by the analyzing laboratory.`;
          } else if (result.flag === "H") {
            severity = "warning";
            direction = "high";
            reason = `Lab result flagged as high (H) by the analyzing laboratory.`;
          } else if (result.flag === "L") {
            severity = "warning";
            direction = "low";
            reason = `Lab result flagged as low (L) by the analyzing laboratory.`;
          } else if (result.flag !== undefined && result.flag !== null) {
            // Non-enum flag value — warn unconditionally and optionally
            // map known HL7v2 abnormal-flag values to warnings. Others
            // fall through to the range checks below.
            // Issue #851: event name must match the metric field string
            // (convention elsewhere in the service, e.g.
            // `utils/validate-event-timestamp.ts`, uses the `_total` suffix
            // for both so log-based aggregations and Prometheus counters
            // stay in sync). Historically the event name was the
            // non-suffixed "unrecognized_lab_flag".
            logger.warn("unrecognized_lab_flag_total", {
              metric: "unrecognized_lab_flag_total",
              flag: result.flag,
              test_name: result.test_name,
              test_code: result.test_code,
            });
            const mapped = HL7_FLAG_MAPPINGS[result.flag];
            if (mapped) {
              severity = mapped.severity;
              direction = mapped.direction;
              reason =
                `Lab result flagged as ${result.flag} by the analyzing laboratory ` +
                `(HL7v2 abnormal-flag mapped to ${mapped.severity} / ${mapped.direction}).`;
            }
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
            // Include direction in the summary for all severities so that
            // downstream consumers (and the clinicians reading the flag)
            // can tell panic-low from panic-high at a glance. Previously
            // the critical-severity prefix omitted direction, which hid
            // the #833 direction-inference bug.
            const summaryPrefix =
              severity === "critical"
                ? resolvedDirection === "high"
                  ? "Critical high lab result"
                  : "Critical low lab result"
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
              rule_id: buildLabRuleId(
                severity,
                result.test_name.replace(/\s+/g, "_").toUpperCase(),
              ),
            });
          } else if (
            // ── 3. Unable-to-evaluate fallback (issue #835) ─────────
            // A result with NO `flag`, NO `reference_low` / `reference_high`,
            // and NOT in `COMMON_LAB_TESTS` currently has no signal at all.
            // Example from issue #835: a non-canonical "Potassium Level"
            // with value 8.0 slips past the deterministic layer entirely
            // because the canonical matcher requires "Potassium".
            //
            // We do NOT know whether the value is abnormal — firing
            // critical would be over-alerting. Instead, emit an
            // info-severity signal so the downstream LLM review pipeline
            // can assemble context around the result, and log a
            // structured warning for operator observability.
            //
            // Preconditions (must all hold to reach this branch):
            //   - severity is still null (no flag match, no range match,
            //     not flagged as critical, not in COMMON_LAB_TESTS)
            //   - result.flag is undefined / null (any flag would have
            //     gone through branch 2 above, emitted a warn, and
            //     possibly fallen through; we only want truly silent labs)
            //   - no reference bounds at all
            //   - not in COMMON_LAB_TESTS
            result.flag === undefined ||
            result.flag === null
          ) {
            const hasReferenceRange =
              result.reference_low !== undefined ||
              result.reference_high !== undefined;
            const inCommonLabTests = COMMON_LAB_TESTS[result.test_name] !== undefined;

            if (
              !hasReferenceRange &&
              !inCommonLabTests &&
              !matchedExplicitDef
            ) {
              logger.warn("lab_unevaluated_total", {
                metric: "lab_unevaluated_total",
                test_name: result.test_name,
                test_code: result.test_code,
                value: result.value,
                unit: result.unit,
              });

              // Issue #867: escalate info → warning when the raw magnitude
              // of the value is outside the coarse any-analyte-plausible
              // window. See `isExtremeNumericValue` for rationale and
              // threshold choice. This is additive — values in the window
              // continue to emit info as introduced by PR #860.
              const escalate = isExtremeNumericValue(result.value);
              const severity: FlagSeverity = escalate ? "warning" : "info";
              const rationale = escalate
                ? `Lab result for "${result.test_name}" arrived with no lab-provided ` +
                  `flag, no reference range, and no entry in COMMON_LAB_TESTS. The ` +
                  `deterministic rule layer cannot map the value to an analyte-specific ` +
                  `threshold, but the raw magnitude (${result.value} ${result.unit}) ` +
                  `falls outside the coarse any-analyte-plausible window ` +
                  `(${EXTREME_VALUE_LOW}–${EXTREME_VALUE_HIGH}). Escalating to warning ` +
                  `as a signal-over-noise hint: values of this magnitude usually ` +
                  `indicate a data-entry or unit/decimal error worth clinician review.`
                : `Lab result for "${result.test_name}" arrived with no lab-provided ` +
                  `flag, no reference range, and no entry in COMMON_LAB_TESTS. The ` +
                  `deterministic rule layer cannot assess the value against a threshold; ` +
                  `surfacing as an info signal so LLM review and clinicians have visibility.`;

              flags.push({
                severity,
                category: "critical-value",
                summary:
                  `Lab result not evaluable by deterministic rules: ` +
                  `${result.test_name} = ${result.value} ${result.unit}`,
                rationale,
                suggested_action:
                  `Clinician review recommended. Verify test name mapping and reference ` +
                  `range metadata with the sending laboratory. Consider adding this test ` +
                  `to COMMON_LAB_TESTS or CRITICAL_LAB_THRESHOLDS if clinically relevant.`,
                notify_specialties: [],
                rule_id: buildLabRuleId(
                  severity,
                  `UNEVALUATED-${result.test_name.replace(/\s+/g, "_").toUpperCase()}`,
                ),
              });
            }
          }
        }
      }
    }
  }

  return flags;
}
