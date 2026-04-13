/**
 * Weight-based dose validation for high-risk medications.
 *
 * Flags when a prescribed dose exceeds weight-adjusted maximums for drugs
 * where weight-based dosing is the clinical standard. When no patient weight
 * is on file, emits an INFO-level suggestion to document weight.
 *
 * References:
 *  - Acetaminophen: max 75 mg/kg/day, absolute cap 4 g/day
 *  - Ibuprofen: max 40 mg/kg/day
 *  - Vancomycin: typical 15–20 mg/kg per dose
 *  - Gentamicin: typical 5–7 mg/kg per dose
 */

export type DoseAlertSeverity = "WARNING" | "INFO";

export interface DoseAlert {
  severity: DoseAlertSeverity;
  message: string;
  drugName: string;
  ruleId: string;
}

export interface WeightBasedDoseInput {
  /** Medication name (case-insensitive matching) */
  medicationName: string;
  /** Single dose amount in mg */
  doseMg: number;
  /** Number of doses per day (used for daily-max drugs like acetaminophen/ibuprofen) */
  dosesPerDay?: number;
  /** Patient weight in kilograms, or undefined if not documented */
  weightKg?: number | null;
}

interface DrugRule {
  /** Unique rule identifier */
  ruleId: string;
  /** Regex patterns to match medication names (case-insensitive) */
  namePatterns: RegExp[];
  /** Validation mode: "per-dose" checks a single dose, "daily" checks total daily dose */
  mode: "per-dose" | "daily";
  /** Max mg/kg (per-dose or per-day depending on mode) */
  maxMgPerKg: number;
  /** Absolute ceiling in mg (per-dose or per-day depending on mode), regardless of weight */
  absoluteMaxMg?: number;
  /** Human-readable dosing guidance for alert messages */
  guidance: string;
}

const DRUG_RULES: DrugRule[] = [
  {
    ruleId: "DOSE-WT-APAP-001",
    namePatterns: [/acetaminophen/i, /tylenol/i, /paracetamol/i],
    mode: "daily",
    maxMgPerKg: 75,
    absoluteMaxMg: 4000,
    guidance: "max 75 mg/kg/day, absolute max 4 g/day",
  },
  {
    ruleId: "DOSE-WT-IBU-001",
    namePatterns: [/ibuprofen/i, /advil/i, /motrin/i],
    mode: "daily",
    maxMgPerKg: 40,
    absoluteMaxMg: undefined,
    guidance: "max 40 mg/kg/day",
  },
  {
    ruleId: "DOSE-WT-VANC-001",
    namePatterns: [/vancomycin/i],
    mode: "per-dose",
    maxMgPerKg: 20,
    absoluteMaxMg: undefined,
    guidance: "typical 15-20 mg/kg per dose",
  },
  {
    ruleId: "DOSE-WT-GENT-001",
    namePatterns: [/gentamicin/i],
    mode: "per-dose",
    maxMgPerKg: 7,
    absoluteMaxMg: undefined,
    guidance: "typical 5-7 mg/kg per dose",
  },
];

function matchDrugRule(medicationName: string): DrugRule | undefined {
  const name = medicationName.trim();
  return DRUG_RULES.find((rule) =>
    rule.namePatterns.some((pattern) => pattern.test(name))
  );
}

/**
 * Check a medication dose against weight-based maximums.
 *
 * Returns an array of alerts (may be empty if no issues found).
 */
export function checkWeightBasedDosing(input: WeightBasedDoseInput): DoseAlert[] {
  const alerts: DoseAlert[] = [];
  const rule = matchDrugRule(input.medicationName);

  if (!rule) return alerts;

  // If weight is not documented, suggest documenting it
  if (input.weightKg == null) {
    alerts.push({
      severity: "INFO",
      message: `Patient weight not documented. Weight-based dosing check skipped for ${input.medicationName} (${rule.guidance}).`,
      drugName: input.medicationName,
      ruleId: rule.ruleId,
    });
    return alerts;
  }

  const weightKg = input.weightKg;

  if (weightKg <= 0) {
    alerts.push({
      severity: "WARNING",
      message: `Invalid patient weight (${weightKg} kg). Cannot perform weight-based dose check for ${input.medicationName}.`,
      drugName: input.medicationName,
      ruleId: rule.ruleId,
    });
    return alerts;
  }

  const weightBasedMax = rule.maxMgPerKg * weightKg;

  if (rule.mode === "daily") {
    const dosesPerDay = input.dosesPerDay ?? 1;
    const dailyTotal = input.doseMg * dosesPerDay;

    // Check absolute ceiling first
    if (rule.absoluteMaxMg != null && dailyTotal > rule.absoluteMaxMg) {
      alerts.push({
        severity: "WARNING",
        message: `${input.medicationName} daily total ${dailyTotal} mg exceeds absolute maximum of ${rule.absoluteMaxMg} mg/day (${rule.guidance}).`,
        drugName: input.medicationName,
        ruleId: rule.ruleId,
      });
    }

    // Check weight-based limit
    if (dailyTotal > weightBasedMax) {
      const mgPerKgActual = Math.round((dailyTotal / weightKg) * 10) / 10;
      alerts.push({
        severity: "WARNING",
        message: `${input.medicationName} daily total ${dailyTotal} mg (${mgPerKgActual} mg/kg/day) exceeds weight-based maximum of ${rule.maxMgPerKg} mg/kg/day for ${weightKg} kg patient (${rule.guidance}).`,
        drugName: input.medicationName,
        ruleId: rule.ruleId,
      });
    }
  } else {
    // per-dose mode
    if (input.doseMg > weightBasedMax) {
      const mgPerKgActual = Math.round((input.doseMg / weightKg) * 10) / 10;
      alerts.push({
        severity: "WARNING",
        message: `${input.medicationName} dose ${input.doseMg} mg (${mgPerKgActual} mg/kg) exceeds weight-based maximum of ${rule.maxMgPerKg} mg/kg for ${weightKg} kg patient (${rule.guidance}).`,
        drugName: input.medicationName,
        ruleId: rule.ruleId,
      });
    }
  }

  return alerts;
}
