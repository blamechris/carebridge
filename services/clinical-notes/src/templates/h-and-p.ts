import type { NoteSection } from "@carebridge/shared-types";
import { ROS_SYMPTOMS } from "@carebridge/shared-types";

/**
 * Creates a History & Physical note template with comprehensive
 * sections for initial patient evaluation and examination.
 */
export function createHAndPTemplate(): NoteSection[] {
  return [
    {
      key: "chief_complaint",
      label: "Chief Complaint",
      fields: [
        {
          key: "chief_complaint",
          label: "Chief Complaint",
          value: null,
          field_type: "text",
          source: "new_entry",
        },
      ],
    },
    {
      key: "hpi",
      label: "History of Present Illness",
      fields: [
        {
          key: "hpi",
          label: "History of Present Illness",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "review_of_systems",
      label: "Review of Systems",
      fields: [
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
      key: "past_medical_history",
      label: "Past Medical History",
      fields: [
        {
          key: "pmh",
          label: "Past Medical History",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "past_surgical_history",
      label: "Past Surgical History",
      fields: [
        {
          key: "psh",
          label: "Past Surgical History",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "family_history",
      label: "Family History",
      fields: [
        {
          key: "family_history",
          label: "Family History",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "social_history",
      label: "Social History",
      fields: [
        {
          key: "social_history",
          label: "Social History",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "physical_exam",
      label: "Physical Exam",
      fields: [
        {
          key: "general",
          label: "General",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "heent",
          label: "HEENT",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "cardiovascular",
          label: "Cardiovascular",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "respiratory",
          label: "Respiratory",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "abdomen",
          label: "Abdomen",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "neurological",
          label: "Neurological",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "musculoskeletal",
          label: "Musculoskeletal",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "skin",
          label: "Skin",
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
          key: "assessment",
          label: "Assessment",
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
          key: "plan",
          label: "Plan",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
  ];
}
