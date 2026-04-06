import { z } from "zod";

export const biologicalSexSchema = z.enum(["male", "female", "unknown"]);

export const createPatientSchema = z.object({
  name: z.string().min(1).max(200),
  date_of_birth: z.string().date().optional(),
  biological_sex: biologicalSexSchema.optional(),
  diagnosis: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  mrn: z.string().max(50).optional(),
  insurance_id: z.string().max(100).optional(),
  emergency_contact_name: z.string().max(200).optional(),
  emergency_contact_phone: z.string().max(30).optional(),
  primary_provider_id: z.string().uuid().optional(),
});

export const updatePatientSchema = createPatientSchema.partial();

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
