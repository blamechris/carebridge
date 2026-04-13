import { z } from "zod";

// ─── ICD-10-CM format ───────────────────────────────────────────

/** Matches ICD-10-CM codes: letter + 2 digits, optional dot + 1-4 digits */
export const icd10CodeSchema = z
  .string()
  .regex(/^[A-Z]\d{2}(\.\d{1,4})?$/, "Invalid ICD-10-CM code format (e.g. A01, A01.1, A01.1234)");

// ─── Vitals ──────────────────────────────────────────────────────

export const vitalTypeSchema = z.enum([
  "blood_pressure", "heart_rate", "o2_sat", "temperature",
  "weight", "respiratory_rate", "pain_level", "blood_glucose",
]);

export const createVitalSchema = z.object({
  patient_id: z.string().uuid(),
  recorded_at: z.string().datetime(),
  type: vitalTypeSchema,
  value_primary: z.number(),
  value_secondary: z.number().optional(),
  unit: z.string().min(1).max(20),
  notes: z.string().max(2000).optional(),
  provider_id: z.string().uuid().optional(),
  encounter_id: z.string().uuid().optional(),
});

export type CreateVitalInput = z.infer<typeof createVitalSchema>;

// ─── Medications ─────────────────────────────────────────────────

export const medRouteSchema = z.enum([
  "oral", "IV", "IM", "subcutaneous", "topical", "inhaled", "rectal", "other",
]);

export const medStatusSchema = z.enum(["active", "discontinued", "completed"]);

export const createMedicationSchema = z.object({
  patient_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  brand_name: z.string().max(200).optional(),
  dose_amount: z.number().positive().optional(),
  dose_unit: z.string().max(20).optional(),
  route: medRouteSchema.optional(),
  frequency: z.string().max(100).optional(),
  status: medStatusSchema.default("active"),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  prescribed_by: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  rxnorm_code: z.string().max(20).optional(),
  ordering_provider_id: z.string().uuid().optional(),
  encounter_id: z.string().uuid().optional(),
});

export const updateMedicationSchema = createMedicationSchema.partial().omit({ patient_id: true });

export type CreateMedicationInput = z.infer<typeof createMedicationSchema>;
export type UpdateMedicationInput = z.infer<typeof updateMedicationSchema>;

// ─── Lab Panels & Results ────────────────────────────────────────

export const createLabPanelSchema = z.object({
  patient_id: z.string().uuid(),
  panel_name: z.string().min(1).max(100),
  ordered_by: z.string().max(200).optional(),
  collected_at: z.string().datetime().optional(),
  reported_at: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
  ordering_provider_id: z.string().uuid().optional(),
  encounter_id: z.string().uuid().optional(),
  results: z.array(
    z.object({
      test_name: z.string().min(1).max(100),
      test_code: z.string().regex(/^\d{1,5}-\d$/, "Must be a valid LOINC code (e.g. 6690-2)"),
      value: z.number(),
      unit: z.string().min(1).max(20),
      reference_low: z.number().optional(),
      reference_high: z.number().optional(),
      flag: z.enum(["H", "L", "critical"]).optional(),
      notes: z.string().max(2000).optional(),
    })
  ).min(1),
});

export type CreateLabPanelInput = z.infer<typeof createLabPanelSchema>;

// ─── Diagnoses ──────────────────────────────────────────────────

export const diagnosisStatusSchema = z.enum(["active", "chronic", "resolved"]);

export const createDiagnosisSchema = z.object({
  patient_id: z.string().uuid(),
  icd10_code: z.string().regex(/^[A-Z]\d{2}(\.\d{1,4})?$/, "Invalid ICD-10-CM code format"),
  description: z.string().min(1).max(2000),
  status: diagnosisStatusSchema.default("active"),
  onset_date: z.string().date().optional(),
  snomed_code: z.string().max(20).optional(),
});

export const updateDiagnosisSchema = z.object({
  status: diagnosisStatusSchema.optional(),
  description: z.string().min(1).max(2000).optional(),
});

export type CreateDiagnosisInput = z.infer<typeof createDiagnosisSchema>;
export type UpdateDiagnosisInput = z.infer<typeof updateDiagnosisSchema>;

// ─── Allergies ──────────────────────────────────────────────────

export const allergySeveritySchema = z.enum(["mild", "moderate", "severe", "critical"]);

export const createAllergySchema = z.object({
  patient_id: z.string().uuid(),
  allergen: z.string().min(1).max(200),
  reaction: z.string().min(1).max(500),
  severity: allergySeveritySchema,
});

export const updateAllergySchema = z.object({
  severity: allergySeveritySchema.optional(),
  reaction: z.string().min(1).max(500).optional(),
});

export type CreateAllergyInput = z.infer<typeof createAllergySchema>;
export type UpdateAllergyInput = z.infer<typeof updateAllergySchema>;

// ─── Procedures ──────────────────────────────────────────────────

export const procedureStatusSchema = z.enum(["scheduled", "in_progress", "completed", "cancelled"]);

export const createProcedureSchema = z.object({
  patient_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  cpt_code: z.string().max(20).optional(),
  icd10_codes: z.array(icd10CodeSchema).optional(),
  status: procedureStatusSchema.default("scheduled"),
  performed_at: z.string().datetime().optional(),
  performed_by: z.string().max(200).optional(),
  provider_id: z.string().uuid().optional(),
  encounter_id: z.string().uuid().optional(),
  notes: z.string().max(5000).optional(),
});

export type CreateProcedureInput = z.infer<typeof createProcedureSchema>;
