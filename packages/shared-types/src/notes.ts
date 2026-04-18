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

/** Which state transition produced a note_versions archive row. */
export type NoteLifecycleEvent =
  | "draft"
  | "signed"
  | "cosigned"
  | "amended"
  | "unknown";

/** Lightweight note version for history tracking */
export interface NoteVersion {
  note_id: string;
  version: number;
  sections: NoteSection[];
  saved_at: string;
  saved_by: string;
  /**
   * Which state transition caused this archive row. Required to disambiguate
   * rows that share the same `version` number (sign and cosign both archive
   * at `existing.version` without bumping it).
   */
  lifecycle_event: NoteLifecycleEvent;
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
