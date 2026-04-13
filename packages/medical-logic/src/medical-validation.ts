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

export const VITAL_DANGER_ZONES: Record<VitalType, VitalRange> = {
  blood_pressure: { min: 60, max: 250, criticalLow: 70, criticalHigh: 180 },
  heart_rate: { min: 20, max: 300, criticalLow: 40, criticalHigh: 200 },
  o2_sat: { min: 50, max: 100, criticalLow: 85 },
  temperature: { min: 85, max: 115, criticalLow: 95, criticalHigh: 104 },
  weight: { min: 1, max: 1000 },
  respiratory_rate: { min: 4, max: 60, criticalLow: 8, criticalHigh: 30 },
  pain_level: { min: 0, max: 10 },
  blood_glucose: { min: 10, max: 800, criticalLow: 50, criticalHigh: 350, warningLow: 70, warningHigh: 250 },
};

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

/** Check if a vital value is in the critical range (used by rules engine) */
export function isCriticalVital(type: VitalType, value: number): boolean {
  const range = VITAL_DANGER_ZONES[type];
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
