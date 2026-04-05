import type { NoteSection } from "@carebridge/shared-types";
import { ROS_SYMPTOMS } from "@carebridge/shared-types";

/**
 * Creates a SOAP note template with structured sections for
 * Subjective, Objective, Assessment, and Plan.
 */
export function createSOAPTemplate(): NoteSection[] {
  return [
    {
      key: "subjective",
      label: "Subjective",
      fields: [
        {
          key: "chief_complaint",
          label: "Chief Complaint",
          value: null,
          field_type: "text",
          source: "new_entry",
        },
        {
          key: "history_of_present_illness",
          label: "History of Present Illness",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "new_symptoms",
          label: "New Symptoms",
          value: [],
          field_type: "multiselect",
          source: "new_entry",
          options: [
            // Neurological
            "headache",
            "dizziness",
            "numbness",
            "tingling",
            "vision changes",
            "speech difficulty",
            "confusion",
            "syncope",
            "seizure",
            // Cardiovascular
            "chest pain",
            "palpitations",
            "edema",
            // Respiratory
            "cough",
            "shortness of breath",
            "wheezing",
            // Gastrointestinal
            "nausea",
            "vomiting",
            "diarrhea",
            "abdominal pain",
            // Constitutional
            "fever",
            "fatigue",
            "weight loss",
            "night sweats",
          ],
        },
        {
          key: "ros",
          label: "Review of Systems",
          value: [],
          field_type: "multiselect",
          source: "new_entry",
          options: Object.entries(ROS_SYMPTOMS).flatMap(([system, symptoms]) =>
            symptoms.map((s) => `${system}: ${s}`),
          ),
        },
      ],
    },
    {
      key: "objective",
      label: "Objective",
      fields: [
        {
          key: "vitals_summary",
          label: "Vitals Summary",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "physical_exam",
          label: "Physical Exam",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "labs_reviewed",
          label: "Labs Reviewed",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "assessment",
      label: "Assessment",
      fields: [
        {
          key: "active_problems",
          label: "Active Problems (one per line)",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "clinical_impression",
          label: "Clinical Impression",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "plan",
      label: "Plan",
      fields: [
        {
          key: "orders",
          label: "Orders",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "medications_changed",
          label: "Medications Changed",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "referrals",
          label: "Referrals",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "follow_up",
          label: "Follow Up",
          value: null,
          field_type: "text",
          source: "new_entry",
        },
      ],
    },
  ];
}
