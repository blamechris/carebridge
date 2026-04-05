import type { MutableRecord } from "./base.js";

export type BiologicalSex = "male" | "female" | "unknown";

export interface Patient extends MutableRecord {
  name: string;
  date_of_birth?: string;
  biological_sex?: BiologicalSex;
  diagnosis?: string;
  notes?: string;
}

/** Extended patient for the clinical platform (beyond MedLens) */
export interface ClinicalPatient extends Patient {
  mrn?: string; // medical record number
  insurance_id?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  primary_provider_id?: string;
}
