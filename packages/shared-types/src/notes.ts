import type { BaseRecord } from "./base.js";

// ─── Note Templates ──────────────────────────────────────────────

export type NoteTemplateType =
  | "soap"
  | "progress"
  | "h_and_p"
  | "discharge"
  | "consult";

export type FieldSource = "new_entry" | "carried_forward" | "modified";

/** A single structured field within a note section */
export interface NoteField {
  key: string;
  label: string;
  value: string | string[] | boolean | number | null;
  field_type: "text" | "textarea" | "select" | "multiselect" | "checkbox" | "number";
  source: FieldSource;
  options?: string[]; // for select/multiselect
}

/** A section within a clinical note */
export interface NoteSection {
  key: string;
  label: string;
  fields: NoteField[];
  free_text?: string;
}

/** A structured clinical note */
export interface ClinicalNote extends BaseRecord {
  patient_id: string;
  provider_id: string;
  encounter_id?: string;
  template_type: NoteTemplateType;
  sections: NoteSection[];
  version: number;
  status: "draft" | "signed" | "cosigned" | "amended";
  signed_at?: string;
  signed_by?: string;
  cosigned_at?: string;
  cosigned_by?: string;
  copy_forward_score?: number; // 0-100, how much was carried forward
  source_system?: string;
}

/** Lightweight note version for history tracking */
export interface NoteVersion {
  note_id: string;
  version: number;
  sections: NoteSection[];
  saved_at: string;
  saved_by: string;
}

/**
 * Phase C2 — cross-team note timeline entry.
 *
 * Lean projection of a ClinicalNote that the clinician portal's "All Notes"
 * timeline tab renders without decrypting or downloading full note bodies.
 * One entry per note, ordered by the server newest-first.
 *
 * provider_name / provider_specialty are resolved from the users table.
 * assertion_preview is populated from the most recent successful
 * note_assertions row for this note (Phase A1 extraction); it is null when
 * extraction failed, has not yet run, or the note has no signed version.
 */
export interface NoteTimelineEntry {
  id: string;
  patient_id: string;
  provider_id: string;
  provider_name: string | null;
  provider_specialty: string | null;
  template_type: NoteTemplateType;
  status: "draft" | "signed" | "cosigned" | "amended";
  version: number;
  signed_at: string | null;
  cosigned_at: string | null;
  created_at: string;
  copy_forward_score: number | null;
  assertion_preview: {
    one_line_summary: string;
    assessment_problems: string[];
    top_plan_actions: string[];
  } | null;
}

// ─── Review of Systems ───────────────────────────────────────────

export const ROS_SYSTEMS = [
  "constitutional",
  "eyes",
  "ent",
  "cardiovascular",
  "respiratory",
  "gastrointestinal",
  "genitourinary",
  "musculoskeletal",
  "skin",
  "neurological",
  "psychiatric",
  "endocrine",
  "hematologic",
  "allergic_immunologic",
] as const;

export type ROSSystem = (typeof ROS_SYSTEMS)[number];

/** Common symptoms by system for the ROS checklist */
export const ROS_SYMPTOMS: Record<ROSSystem, string[]> = {
  constitutional: ["fever", "weight loss", "weight gain", "fatigue", "malaise", "night sweats"],
  eyes: ["vision change", "eye pain", "double vision", "blurred vision"],
  ent: ["hearing loss", "ear pain", "sore throat", "nasal congestion", "nosebleeds"],
  cardiovascular: ["chest pain", "palpitations", "edema", "orthopnea", "dyspnea on exertion"],
  respiratory: ["cough", "shortness of breath", "wheezing", "hemoptysis"],
  gastrointestinal: ["nausea", "vomiting", "diarrhea", "constipation", "abdominal pain", "blood in stool"],
  genitourinary: ["dysuria", "frequency", "urgency", "hematuria", "incontinence"],
  musculoskeletal: ["joint pain", "muscle pain", "stiffness", "swelling", "weakness"],
  skin: ["rash", "itching", "bruising", "skin changes", "wound"],
  neurological: ["headache", "dizziness", "numbness", "tingling", "vision changes", "speech difficulty", "weakness", "confusion", "syncope", "seizure"],
  psychiatric: ["depression", "anxiety", "insomnia", "mood changes"],
  endocrine: ["heat intolerance", "cold intolerance", "polydipsia", "polyuria"],
  hematologic: ["easy bruising", "bleeding", "blood clots", "lymph node swelling"],
  allergic_immunologic: ["seasonal allergies", "hives", "frequent infections"],
};
