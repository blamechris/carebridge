/**
 * Medical data validation — ported from MedLens
 * Prevents dangerous values from being stored without confirmation.
 */

import type { VitalType } from "@carebridge/shared-types";
import { COMMON_LAB_TESTS } from "@carebridge/shared-types";

export interface VitalRange {
  min: number;
  max: number;
  criticalLow?: number;
  criticalHigh?: number;
  warningLow?: number;
  warningHigh?: number;
}

/** Diastolic-specific thresholds for blood pressure evaluation */
export interface DiastolicRange {
  criticalLow: number;
  criticalHigh: number;
  warningHigh: number;
}

export const DIASTOLIC_DANGER_ZONE: DiastolicRange = {
  criticalLow: 60,
  criticalHigh: 120,
  warningHigh: 90,
};

/** Adult vital sign danger zones (default, used for age >= 18 or when age is unknown) */
export const VITAL_DANGER_ZONES: Record<VitalType, VitalRange> = {
  blood_pressure: { min: 60, max: 250, criticalLow: 70, criticalHigh: 180 },
  heart_rate: { min: 20, max: 300, criticalLow: 40, criticalHigh: 200 },
  o2_sat: { min: 50, max: 100, criticalLow: 85 },
  temperature: { min: 85, max: 115, criticalLow: 95, criticalHigh: 104 },
  weight: { min: 1, max: 1000 },
  respiratory_rate: { min: 4, max: 60, criticalLow: 8, criticalHigh: 30 },
  pain_level: { min: 0, max: 10 },
  blood_glucose: { min: 10, max: 800, criticalLow: 54, criticalHigh: 350, warningLow: 70, warningHigh: 250 },
};

// ─── Age-Stratified Vital Ranges (Pediatric) ───────────────────

export type AgeGroup =
  | "neonate"    // 0–28 days
  | "infant"     // 1–12 months
  | "child"      // 1–5 years
  | "school_age" // 6–12 years
  | "adolescent" // 13–17 years
  | "adult";     // 18+ years

/** Age-stratified vital sign ranges keyed by age group, then by vital type. */
export const PEDIATRIC_VITAL_RANGES: Record<
  Exclude<AgeGroup, "adult">,
  Partial<Record<VitalType, VitalRange>>
> = {
  neonate: {
    heart_rate: { min: 70, max: 220, criticalLow: 100, criticalHigh: 160 },
    respiratory_rate: { min: 20, max: 80, criticalLow: 30, criticalHigh: 60 },
    blood_pressure: { min: 40, max: 120, criticalLow: 60, criticalHigh: 90 },
  },
  infant: {
    heart_rate: { min: 70, max: 200, criticalLow: 100, criticalHigh: 150 },
    respiratory_rate: { min: 15, max: 70, criticalLow: 25, criticalHigh: 50 },
    blood_pressure: { min: 50, max: 130, criticalLow: 70, criticalHigh: 100 },
  },
  child: {
    heart_rate: { min: 50, max: 200, criticalLow: 80, criticalHigh: 130 },
    respiratory_rate: { min: 12, max: 40, criticalLow: 20, criticalHigh: 30 },
    blood_pressure: { min: 60, max: 140, criticalLow: 80, criticalHigh: 110 },
  },
  school_age: {
    heart_rate: { min: 40, max: 200, criticalLow: 70, criticalHigh: 110 },
    respiratory_rate: { min: 10, max: 35, criticalLow: 16, criticalHigh: 22 },
    blood_pressure: { min: 60, max: 160, criticalLow: 85, criticalHigh: 120 },
  },
  adolescent: {
    heart_rate: { min: 30, max: 250, criticalLow: 60, criticalHigh: 100 },
    respiratory_rate: { min: 6, max: 40, criticalLow: 12, criticalHigh: 20 },
    blood_pressure: { min: 60, max: 200, criticalLow: 95, criticalHigh: 140 },
  },
};

/**
 * Classify age in years into an age group.
 * Fractional years are used for infants/neonates:
 *  - neonate: 0 to ~0.077 years (28 days)
 *  - infant: ~0.077 to 1 year
 */
export function classifyAgeGroup(ageYears: number): AgeGroup {
  if (ageYears < 0) return "adult"; // invalid age, fall back to adult
  if (ageYears < 28 / 365.25) return "neonate";
  if (ageYears < 1) return "infant";
  if (ageYears < 6) return "child";
  if (ageYears < 13) return "school_age";
  if (ageYears < 18) return "adolescent";
  return "adult";
}

/**
 * Compute age in fractional years from a date-of-birth ISO string.
 * Returns undefined if dateOfBirth is falsy or unparseable.
 */
export function ageInYearsFromDOB(
  dateOfBirth: string | undefined | null,
  referenceDate?: Date
): number | undefined {
  if (!dateOfBirth) return undefined;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return undefined;
  const ref = referenceDate ?? new Date();
  const diffMs = ref.getTime() - dob.getTime();
  if (diffMs < 0) return undefined;
  return diffMs / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Return the appropriate VitalRange for the given vital type and patient age.
 * Falls back to adult ranges when age is unknown or no pediatric range is defined
 * for that vital type.
 */
export function getVitalRangeForAge(
  vitalType: VitalType,
  ageYears?: number | undefined
): VitalRange {
  const adultRange = VITAL_DANGER_ZONES[vitalType];
  if (ageYears === undefined || ageYears === null) return adultRange;

  const group = classifyAgeGroup(ageYears);
  if (group === "adult") return adultRange;

  const pediatricRange = PEDIATRIC_VITAL_RANGES[group]?.[vitalType];
  return pediatricRange ?? adultRange;
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateVital(
  type: VitalType,
  primary: number,
  secondary?: number
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const range = VITAL_DANGER_ZONES[type];

  if (!range) return { valid: true, warnings: [], errors: [] };

  if (isNaN(primary)) {
    errors.push("Value must be a number");
    return { valid: false, warnings, errors };
  }

  if (primary < range.min || primary > range.max) {
    errors.push(
      `${type.replace(/_/g, " ")} value ${primary} is outside plausible range (${range.min}–${range.max})`
    );
  }

  if (range.criticalLow && primary < range.criticalLow) {
    warnings.push(`Critically low ${type.replace(/_/g, " ")}: ${primary}`);
  } else if (range.warningLow && primary < range.warningLow) {
    warnings.push(`Low ${type.replace(/_/g, " ")}: ${primary}`);
  }
  if (range.criticalHigh && primary > range.criticalHigh) {
    warnings.push(`Critically high ${type.replace(/_/g, " ")}: ${primary}`);
  } else if (range.warningHigh && primary > range.warningHigh) {
    warnings.push(`High ${type.replace(/_/g, " ")}: ${primary}`);
  }

  if (type === "blood_pressure" && secondary != null) {
    if (secondary >= primary) {
      errors.push("Diastolic (bottom number) must be less than systolic (top number)");
    }
    if (secondary < 20 || secondary > 200) {
      errors.push(`Diastolic ${secondary} is outside plausible range (20–200)`);
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

export function validateMedicationDose(
  doseAmount: number | undefined,
  doseUnit: string | undefined
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (doseAmount == null) return { valid: true, warnings, errors };

  if (isNaN(doseAmount)) {
    errors.push("Dose must be a number");
    return { valid: false, warnings, errors };
  }

  if (doseAmount <= 0) errors.push("Dose must be a positive number");
  if (doseAmount > 10000) errors.push("Dose exceeds 10,000 — verify this is correct");

  const unit = doseUnit?.toLowerCase();
  if (unit === "mg" && doseAmount > 5000) warnings.push(`${doseAmount} mg is unusually high — verify`);
  if (unit === "mcg" && doseAmount > 1000) warnings.push(`${doseAmount} mcg is unusually high — verify`);
  if (unit === "ml" && doseAmount > 500) warnings.push(`${doseAmount} mL is unusually high — verify`);

  return { valid: errors.length === 0, warnings, errors };
}

export function validateLabResult(
  testName: string,
  value: number,
  unit?: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (isNaN(value)) {
    errors.push("Value must be a number");
    return { valid: false, warnings, errors };
  }

  const ref = COMMON_LAB_TESTS[testName];
  if (!ref) return { valid: true, warnings, errors };

  if (value < ref.typical_low) {
    warnings.push(
      `${testName} value ${value} ${unit ?? ref.unit} is below typical range (${ref.typical_low}–${ref.typical_high} ${ref.unit})`
    );
  }
  if (value > ref.typical_high) {
    warnings.push(
      `${testName} value ${value} ${unit ?? ref.unit} is above typical range (${ref.typical_low}–${ref.typical_high} ${ref.unit})`
    );
  }

  return { valid: errors.length === 0, warnings, errors };
}

/**
 * Check if a vital value is in the critical range (used by rules engine).
 * When ageYears is provided, uses age-appropriate pediatric thresholds.
 */
export function isCriticalVital(
  type: VitalType,
  value: number,
  ageYears?: number | undefined
): boolean {
  const range = getVitalRangeForAge(type, ageYears);
  if (!range) return false;
  if (range.criticalLow !== undefined && value <= range.criticalLow) return true;
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) return true;
  return false;
}

/** Return severity level for a vital value: "critical", "warning", or null if normal */
export function getVitalSeverity(
  type: VitalType,
  value: number
): "critical" | "warning" | null {
  const range = VITAL_DANGER_ZONES[type];
  if (!range) return null;

  // Check critical thresholds first (most severe)
  if (range.criticalLow !== undefined && value <= range.criticalLow) return "critical";
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) return "critical";

  // Check warning thresholds
  if (range.warningLow !== undefined && value < range.warningLow) return "warning";
  if (range.warningHigh !== undefined && value > range.warningHigh) return "warning";

  return null;
}

/** Severity level for diastolic evaluation */
export type DiastolicSeverity = "critical" | "warning" | null;

/** Check diastolic BP and return severity (critical, warning, or null) */
export function checkDiastolicBP(diastolic: number): DiastolicSeverity {
  if (diastolic < DIASTOLIC_DANGER_ZONE.criticalLow) return "critical";
  if (diastolic >= DIASTOLIC_DANGER_ZONE.criticalHigh) return "critical";
  if (diastolic >= DIASTOLIC_DANGER_ZONE.warningHigh) return "warning";
  return null;
}
