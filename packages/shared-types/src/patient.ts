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

/**
 * Phase C1 — unified problem-list entry.
 *
 * The clinician portal aggregates active diagnoses across every specialty
 * on the patient's care team into a single problem list. Each entry fuses:
 *   - the underlying diagnosis record (codes, onset, status)
 *   - the care-team specialists currently managing that problem
 *   - the most recent signed note referencing the problem
 *   - the count of open AI flags for this patient (surfaced on every entry
 *     because flags aren't yet tied to a specific diagnosis — see Phase C3)
 *
 * `last_touched_at` is the most recent of:
 *   - the diagnosis row's own created_at
 *   - the most_recent_note.signed_at (if any)
 * `stale_days` is `now - last_touched_at` in whole days; the portal uses it
 * to highlight orphaned problems nobody has touched in a while.
 */
export interface UnifiedProblem {
  diagnosis_id: string;
  patient_id: string;
  description: string;
  icd10_code: string | null;
  snomed_code: string | null;
  status: string;
  onset_date: string | null;
  diagnosed_by: string | null;
  managing_specialists: {
    provider_id: string;
    role: string;
    specialty: string | null;
  }[];
  most_recent_note: {
    id: string;
    provider_id: string;
    provider_specialty: string | null;
    template_type: string;
    signed_at: string | null;
  } | null;
  open_flag_count: number;
  last_touched_at: string;
  stale_days: number;
}
