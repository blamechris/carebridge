/**
 * Static prep instructions by appointment type (#895).
 *
 * The canonical set of appointment types is declared once in
 * `@carebridge/validators` (see `appointmentTypeSchema`) so runtime + compile
 * checks share a single source of truth. The DB column is still plain `text`
 * — see the schema comment in `packages/db-schema/src/schema/scheduling.ts`
 * and the follow-up tracked to promote it to a `pgEnum`. Until then, this
 * `Record<AppointmentType, string>` map is the strongest compile-time
 * guarantee we have: adding a new variant to the Zod enum forces every
 * consumer (this map + the booking wizard's list) to add a matching entry.
 *
 * TODO(issue #332 follow-up): replace with server-side content so clinicians
 * can maintain per-type prep text without a frontend deploy.
 */

import { appointmentTypeSchema, type AppointmentType } from "@carebridge/validators";

export type { AppointmentType };
export { appointmentTypeSchema };

/** Ordered list of canonical appointment types, derived from the Zod enum. */
export const APPOINTMENT_TYPES: readonly AppointmentType[] =
  appointmentTypeSchema.options;

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

/** Type guard — narrows an unknown string to the enum literal. */
export function isAppointmentType(t: string): t is AppointmentType {
  return appointmentTypeSchema.safeParse(t).success;
}

export function prepInstructionsFor(type: string): string {
  if (isAppointmentType(type)) {
    return PREP_INSTRUCTIONS[type];
  }
  return "Please arrive 10 minutes early to check in. Bring a list of current medications and any questions you have.";
}

const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  follow_up: "Follow-up",
  new_patient: "New Patient",
  procedure: "Procedure",
  telehealth: "Telehealth",
};

export function appointmentTypeLabel(type: string): string {
  if (isAppointmentType(type)) {
    return APPOINTMENT_TYPE_LABELS[type];
  }
  return type.replace(/_/g, " ");
}
