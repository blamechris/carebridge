import type { BaseRecord, MutableRecord } from "./base.js";

// ─── Medications ─────────────────────────────────────────────────

export type MedRoute =
  | "oral"
  | "IV"
  | "IM"
  | "subcutaneous"
  | "topical"
  | "inhaled"
  | "rectal"
  | "other";

/**
 * Medication lifecycle status.
 *
 * - `active`       — currently administered / taken.
 * - `held`         — temporarily paused (peri-op, adverse event, awaiting labs)
 *                    with intent to resume. Required by rule
 *                    `ONCO-ANTICOAG-HELD-001`, which flags held anticoagulants
 *                    in patients with active VTE.
 * - `discontinued` — permanently stopped.
 * - `completed`    — finished planned course (e.g. antibiotic regimen done).
 */
export type MedStatus = "active" | "held" | "discontinued" | "completed";

export interface Medication extends MutableRecord {
  patient_id: string;
  name: string;
  brand_name?: string;
  dose_amount?: number;
  dose_unit?: string;
  route?: MedRoute;
  frequency?: string;
  status: MedStatus;
  started_at?: string;
  ended_at?: string;
  prescribed_by?: string;
  notes?: string;
  // Clinical platform extensions
  rxnorm_code?: string;
  ordering_provider_id?: string;
  encounter_id?: string;
  source_system?: string;
}

export interface MedLog extends BaseRecord {
  medication_id: string;
  administered_at: string;
  dose_amount?: number;
  dose_unit?: string;
  administered_by?: string;
  notes?: string;
}

// ─── Vitals ──────────────────────────────────────────────────────

export type VitalType =
  | "blood_pressure"
  | "heart_rate"
  | "o2_sat"
  | "temperature"
  | "weight"
  | "respiratory_rate"
  | "pain_level"
  | "blood_glucose";

export const VITAL_UNITS: Record<VitalType, string> = {
  blood_pressure: "mmHg",
  heart_rate: "bpm",
  o2_sat: "%",
  temperature: "°F",
  weight: "lbs",
  respiratory_rate: "breaths/min",
  pain_level: "/10",
  blood_glucose: "mg/dL",
};

/** LOINC codes for standard vital sign types (FHIR R4 Observation.code) */
export const VITAL_LOINC_CODES: Record<VitalType, string | null> = {
  blood_pressure: "85354-9",
  heart_rate: "8867-4",
  o2_sat: "59408-5",
  temperature: "8310-5",
  weight: "29463-7",
  respiratory_rate: "9279-1",
  pain_level: "72514-3",
  blood_glucose: "2339-0",
};

export interface Vital extends BaseRecord {
  patient_id: string;
  recorded_at: string;
  type: VitalType;
  loinc_code?: string;
  value_primary: number;
  value_secondary?: number;
  unit: string;
  notes?: string;
  // Clinical platform extensions
  provider_id?: string;
  encounter_id?: string;
  source_system?: string;
}

// ─── Lab Results ─────────────────────────────────────────────────

export type LabFlag = "H" | "L" | "critical";

export interface LabPanel extends BaseRecord {
  patient_id: string;
  panel_name: string;
  ordered_by?: string;
  collected_at?: string;
  reported_at?: string;
  notes?: string;
  // Clinical platform extensions
  ordering_provider_id?: string;
  encounter_id?: string;
  source_system?: string;
}

export interface LabResult extends BaseRecord {
  panel_id: string;
  test_name: string;
  test_code?: string; // LOINC code
  value: number;
  unit: string;
  reference_low?: number;
  reference_high?: number;
  flag?: LabFlag;
  notes?: string;
}

// ─── Procedures ──────────────────────────────────────────────────

export type ProcedureStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export interface Procedure extends BaseRecord {
  patient_id: string;
  name: string;
  cpt_code?: string;
  icd10_codes?: string[];
  status: ProcedureStatus;
  performed_at?: string;
  performed_by?: string;
  provider_id?: string;
  encounter_id?: string;
  notes?: string;
  source_system?: string;
}

// ─── Events / Timeline ──────────────────────────────────────────

export type EventCategory =
  | "doctor_visit"
  | "symptom"
  | "procedure"
  | "chemo_session"
  | "radiation"
  | "note"
  | "discharge"
  | "admission"
  | "follow_up";

export type Severity = "info" | "warning" | "urgent";

export interface CareEvent extends BaseRecord {
  patient_id: string;
  occurred_at: string;
  category: EventCategory;
  title: string;
  body?: string;
  severity: Severity;
  provider_id?: string;
  encounter_id?: string;
}

// ─── Reference Data ──────────────────────────────────────────────

/**
 * Reference entry for a common lab test.
 *
 * `unit` is the canonical unit used by CareBridge for the test's typical
 * range. `allowed_units` (optional) enumerates every unit string the system
 * will accept from inbound FHIR or manual entry — if a caller submits a
 * value with a unit outside this set, validation rejects it with an error.
 *
 * Populate `allowed_units` for any test where the unit choice is a known
 * sentinel-event source (e.g. glucose mg/dL vs mmol/L — the 18:1 ratio
 * turns 200 mg/dL ≈ 11.1 mmol/L into a fatal over/under if confused).
 * Tests without `allowed_units` trigger a non-fatal warning on mismatch.
 */
export interface CommonLabTest {
  unit: string;
  typical_low: number;
  typical_high: number;
  allowed_units?: string[];
}

export const COMMON_LAB_TESTS: Record<string, CommonLabTest> = {
  // CBC
  WBC: { unit: "K/uL", typical_low: 4.5, typical_high: 11.0 },
  RBC: { unit: "M/uL", typical_low: 4.0, typical_high: 5.5 },
  Hemoglobin: { unit: "g/dL", typical_low: 12.0, typical_high: 17.5 },
  Hematocrit: { unit: "%", typical_low: 36, typical_high: 51 },
  Platelets: { unit: "K/uL", typical_low: 150, typical_high: 400 },
  ANC: { unit: "K/uL", typical_low: 1.5, typical_high: 8.0 },
  MCV: { unit: "fL", typical_low: 80, typical_high: 100 },
  MCH: { unit: "pg", typical_low: 27, typical_high: 33 },
  MCHC: { unit: "g/dL", typical_low: 32, typical_high: 36 },
  RDW: { unit: "%", typical_low: 11.5, typical_high: 14.5 },
  MPV: { unit: "fL", typical_low: 7.5, typical_high: 11.5 },
  // CBC Differential
  Neutrophils: { unit: "%", typical_low: 40, typical_high: 70 },
  Lymphocytes: { unit: "%", typical_low: 20, typical_high: 40 },
  Monocytes: { unit: "%", typical_low: 2, typical_high: 8 },
  Eosinophils: { unit: "%", typical_low: 1, typical_high: 4 },
  Basophils: { unit: "%", typical_low: 0, typical_high: 1 },
  // Comprehensive Metabolic Panel
  // High-stakes tests locked to a strict unit allow-list. Any other unit
  // (including silent absence, handled separately) is a validation error.
  // mg/dL vs mmol/L glucose is a classic sentinel-event source — 200 mg/dL
  // administered as 200 mmol/L insulin dosing guidance is fatal.
  Glucose: { unit: "mg/dL", typical_low: 70, typical_high: 100, allowed_units: ["mg/dL"] },
  BUN: { unit: "mg/dL", typical_low: 7, typical_high: 20, allowed_units: ["mg/dL"] },
  Creatinine: { unit: "mg/dL", typical_low: 0.6, typical_high: 1.2, allowed_units: ["mg/dL"] },
  GFR: { unit: "mL/min", typical_low: 90, typical_high: 120 },
  Sodium: { unit: "mEq/L", typical_low: 136, typical_high: 145, allowed_units: ["mEq/L", "mmol/L"] },
  Potassium: { unit: "mEq/L", typical_low: 3.5, typical_high: 5.0, allowed_units: ["mEq/L", "mmol/L"] },
  Chloride: { unit: "mEq/L", typical_low: 98, typical_high: 106, allowed_units: ["mEq/L", "mmol/L"] },
  CO2: { unit: "mEq/L", typical_low: 23, typical_high: 29, allowed_units: ["mEq/L", "mmol/L"] },
  Calcium: { unit: "mg/dL", typical_low: 8.5, typical_high: 10.5, allowed_units: ["mg/dL"] },
  "Total Protein": { unit: "g/dL", typical_low: 6.0, typical_high: 8.3 },
  Albumin: { unit: "g/dL", typical_low: 3.5, typical_high: 5.5 },
  // Hepatic Panel
  ALT: { unit: "U/L", typical_low: 7, typical_high: 56 },
  AST: { unit: "U/L", typical_low: 10, typical_high: 40 },
  ALP: { unit: "U/L", typical_low: 44, typical_high: 147 },
  "Total Bilirubin": { unit: "mg/dL", typical_low: 0.1, typical_high: 1.2 },
  "Direct Bilirubin": { unit: "mg/dL", typical_low: 0, typical_high: 0.3 },
  GGT: { unit: "U/L", typical_low: 0, typical_high: 65 },
  LDH: { unit: "U/L", typical_low: 140, typical_high: 280 },
  // Electrolytes & Minerals
  Magnesium: { unit: "mg/dL", typical_low: 1.7, typical_high: 2.2 },
  Phosphorus: { unit: "mg/dL", typical_low: 2.5, typical_high: 4.5 },
  Iron: { unit: "mcg/dL", typical_low: 60, typical_high: 170 },
  Ferritin: { unit: "ng/mL", typical_low: 12, typical_high: 300 },
  "Uric Acid": { unit: "mg/dL", typical_low: 3.0, typical_high: 7.0 },
  // Thyroid
  TSH: { unit: "mIU/L", typical_low: 0.4, typical_high: 4.0 },
  "Free T4": { unit: "ng/dL", typical_low: 0.8, typical_high: 1.8 },
  "Free T3": { unit: "pg/mL", typical_low: 2.3, typical_high: 4.2 },
  // Coagulation
  INR: { unit: "", typical_low: 0.8, typical_high: 1.2 },
  PT: { unit: "sec", typical_low: 11, typical_high: 13.5 },
  aPTT: { unit: "sec", typical_low: 25, typical_high: 35 },
  Fibrinogen: { unit: "mg/dL", typical_low: 200, typical_high: 400 },
  "D-Dimer": { unit: "ng/mL", typical_low: 0, typical_high: 500 },
  // Inflammatory Markers
  CRP: { unit: "mg/L", typical_low: 0, typical_high: 10 },
  ESR: { unit: "mm/hr", typical_low: 0, typical_high: 20 },
  Procalcitonin: { unit: "ng/mL", typical_low: 0, typical_high: 0.1 },
  // Cardiac
  Troponin: { unit: "ng/mL", typical_low: 0, typical_high: 0.04 },
  BNP: { unit: "pg/mL", typical_low: 0, typical_high: 100 },
  Lactate: { unit: "mmol/L", typical_low: 0.5, typical_high: 2.2 },
  // Lipids
  "Total Cholesterol": { unit: "mg/dL", typical_low: 0, typical_high: 200 },
  LDL: { unit: "mg/dL", typical_low: 0, typical_high: 100 },
  HDL: { unit: "mg/dL", typical_low: 40, typical_high: 60 },
  Triglycerides: { unit: "mg/dL", typical_low: 0, typical_high: 150 },
  // Vitamins
  "Vitamin D": { unit: "ng/mL", typical_low: 30, typical_high: 100 },
  "Vitamin B12": { unit: "pg/mL", typical_low: 200, typical_high: 900 },
  Folate: { unit: "ng/mL", typical_low: 2.7, typical_high: 17 },
  // Cancer Tumor Markers
  "CA-125": { unit: "U/mL", typical_low: 0, typical_high: 35 },
  "CA 19-9": { unit: "U/mL", typical_low: 0, typical_high: 37 },
  CEA: { unit: "ng/mL", typical_low: 0, typical_high: 3.0 },
  AFP: { unit: "ng/mL", typical_low: 0, typical_high: 10.9 },
  PSA: { unit: "ng/mL", typical_low: 0, typical_high: 4.0 },
  // Other
  Lipase: { unit: "U/L", typical_low: 0, typical_high: 160 },
  Amylase: { unit: "U/L", typical_low: 28, typical_high: 100 },
  /**
   * HbA1c — glycated hemoglobin.
   *
   * Two reporting standards exist:
   *  - NGSP (US): `%`       — normal < 5.7 %, diabetic >= 6.5 %
   *  - IFCC (international): `mmol/mol` — normal < 42, diabetic >= 48
   *
   * Canonical unit is `%` (NGSP). Values submitted in `mmol/mol` are
   * converted to NGSP for range comparison using the IFCC master equation:
   *   NGSP% = (IFCC mmol/mol / 10.929) + 2.15
   */
  HbA1c: {
    unit: "%",
    typical_low: 4.0,
    typical_high: 5.6,
    allowed_units: ["%", "mmol/mol"],
  },
};

export function getLabRange(
  testName: string
): { low: number; high: number } | null {
  const test = COMMON_LAB_TESTS[testName];
  if (test) return { low: test.typical_low, high: test.typical_high };
  return null;
}
