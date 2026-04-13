import type { NoteSection } from "@carebridge/shared-types";

/**
 * Creates a Discharge Summary template with structured sections
 * covering the hospital stay, outcomes, and post-discharge plan.
 */
export function createDischargeTemplate(): NoteSection[] {
  return [
    {
      key: "admission_diagnosis",
      label: "Admission Diagnosis",
      fields: [
        {
          key: "admission_diagnosis",
          label: "Admission Diagnosis",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "discharge_diagnosis",
      label: "Discharge Diagnosis",
      fields: [
        {
          key: "discharge_diagnosis",
          label: "Discharge Diagnosis",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "hospital_course",
      label: "Hospital Course",
      fields: [
        {
          key: "hospital_course",
          label: "Hospital Course",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "procedures",
      label: "Procedures",
      fields: [
        {
          key: "procedures",
          label: "Procedures",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "discharge_medications",
      label: "Discharge Medications",
      fields: [
        {
          key: "discharge_medications",
          label: "Discharge Medications",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "follow_up",
      label: "Follow-Up",
      fields: [
        {
          key: "follow_up",
          label: "Follow-Up",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "discharge_instructions",
      label: "Discharge Instructions",
      fields: [
        {
          key: "discharge_instructions",
          label: "Discharge Instructions",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
  ];
}
