import type { NoteSection } from "@carebridge/shared-types";

/**
 * Creates a Progress note template — a simpler follow-up format
 * covering interval history, current status, and plan changes.
 */
export function createProgressTemplate(): NoteSection[] {
  return [
    {
      key: "interval_history",
      label: "Interval History",
      fields: [
        {
          key: "interval_events",
          label: "Interval Events",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "symptom_changes",
          label: "Symptom Changes",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
      ],
    },
    {
      key: "current_status",
      label: "Current Status",
      fields: [
        {
          key: "current_medications_reviewed",
          label: "Current Medications Reviewed",
          value: false,
          field_type: "checkbox",
          source: "new_entry",
        },
        {
          key: "vitals_reviewed",
          label: "Vitals Reviewed",
          value: false,
          field_type: "checkbox",
          source: "new_entry",
        },
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
          key: "plan_changes",
          label: "Plan Changes",
          value: null,
          field_type: "textarea",
          source: "new_entry",
        },
        {
          key: "next_appointment",
          label: "Next Appointment",
          value: null,
          field_type: "text",
          source: "new_entry",
        },
      ],
    },
  ];
}
