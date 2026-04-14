import type { NoteSection } from "@carebridge/shared-types";

/**
 * Creates a Consultation Note template with structured sections
 * for specialist evaluation and recommendations.
 */
export function createConsultTemplate(): NoteSection[] {
  return [
    {
      key: "reason_for_consultation",
      label: "Reason for Consultation",
      fields: [
        {
          key: "reason_for_consultation",
          label: "Reason for Consultation",
          value: null,
          field_type: "textarea",
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
      key: "relevant_history",
      label: "Relevant History",
      fields: [
        {
          key: "relevant_history",
          label: "Relevant History",
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
          key: "physical_exam",
          label: "Physical Exam",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "data_review",
      label: "Data Review",
      fields: [
        {
          key: "data_review",
          label: "Data Review",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "impression",
      label: "Impression",
      fields: [
        {
          key: "impression",
          label: "Impression",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "recommendations",
      label: "Recommendations",
      fields: [
        {
          key: "recommendations",
          label: "Recommendations",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
  ];
}
