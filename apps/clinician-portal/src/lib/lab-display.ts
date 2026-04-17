/**
 * Pure display-logic helpers for the LabsTab component.
 *
 * Extracted so that inferred-flag derivation, out-of-range detection,
 * and value-color mapping are unit-testable without mounting the full
 * component (which depends on tRPC context).
 */

import type { LabFlag } from "@carebridge/shared-types";

/** The colour CSS custom-property applied to a lab result value. */
export type ValueColor =
  | "var(--critical)"
  | "var(--warning)"
  | "var(--text-primary)";

/** Inferred flag when the server did not supply one. */
export type InferredFlag = "low" | "high" | "";

/**
 * Determine whether a numeric lab value falls outside its reference range.
 */
export function isOutOfRange(
  value: unknown,
  refLow?: number | null,
  refHigh?: number | null,
): boolean {
  if (typeof value !== "number") return false;
  if (typeof refLow === "number" && value < refLow) return true;
  if (typeof refHigh === "number" && value > refHigh) return true;
  return false;
}

/**
 * Map server flag + out-of-range status to a CSS colour variable.
 *
 * Priority order:
 * 1. Server "critical" flag → critical colour
 * 2. Server "H" or "L" flag → warning colour
 * 3. Client-detected out-of-range → warning colour
 * 4. Otherwise → default text colour
 */
export function labValueColor(
  flag: LabFlag | "" | undefined | null,
  outOfRange: boolean,
): ValueColor {
  if (flag === "critical") return "var(--critical)";
  if (flag === "H" || flag === "L") return "var(--warning)";
  if (outOfRange) return "var(--warning)";
  return "var(--text-primary)";
}

/**
 * Derive an inferred H/L flag when the server did not supply one
 * but the value falls outside the reference range.
 *
 * Returns "" when the server already provides a flag or the value
 * is within range (or non-numeric).
 */
export function deriveInferredFlag(
  value: unknown,
  flag: LabFlag | "" | undefined | null,
  refLow?: number | null,
  refHigh?: number | null,
): InferredFlag {
  if (flag) return "";
  if (typeof value !== "number") return "";
  if (typeof refLow === "number" && value < refLow) return "low";
  if (typeof refHigh === "number" && value > refHigh) return "high";
  return "";
}
