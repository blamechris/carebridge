/**
 * Static prep instructions by appointment type.
 *
 * TODO(issue #332 follow-up): replace with server-side content so clinicians
 * can maintain per-type prep text without a frontend deploy.
 */

export type AppointmentType =
  | "follow_up"
  | "new_patient"
  | "procedure"
  | "telehealth";

export const PREP_INSTRUCTIONS: Record<AppointmentType, string> = {
  follow_up:
    "Bring a list of current medications, recent symptoms, and any questions. Please arrive 10 minutes early to check in.",
  new_patient:
    "Bring your photo ID, insurance card, a list of current medications, and prior medical records if available. Please arrive 20 minutes early to complete intake paperwork.",
  procedure:
    "Follow any procedure-specific instructions you received (for example, fasting requirements). Arrange transportation home if sedation is expected. Bring a list of current medications.",
  telehealth:
    "Join the video call 5 minutes early from a quiet, private location with a stable internet connection. Have a list of current medications and recent symptoms ready.",
};

export function prepInstructionsFor(type: string): string {
  if (type in PREP_INSTRUCTIONS) {
    return PREP_INSTRUCTIONS[type as AppointmentType];
  }
  return "Please arrive 10 minutes early to check in. Bring a list of current medications and any questions you have.";
}

export function appointmentTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    follow_up: "Follow-up",
    new_patient: "New Patient",
    procedure: "Procedure",
    telehealth: "Telehealth",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}
