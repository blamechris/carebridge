import { z } from "zod";

/**
 * Canonical appointment type enum (#895).
 *
 * Mirrored here so the set is validated at runtime AND exported as a
 * TypeScript literal union (`AppointmentType`) that downstream code can
 * pin maps to (e.g. `Record<AppointmentType, string>`), forcing a
 * compile error if a new type is added without updating the map.
 *
 * Source of truth: the `appointment_type` column in
 * `packages/db-schema/src/schema/scheduling.ts`. The column is plain
 * `text` today (see schema comment), so this enum is the single runtime
 * + compile-time guardrail until a `pgEnum` lands in the DB.
 */
export const appointmentTypeSchema = z.enum([
  "follow_up",
  "new_patient",
  "procedure",
  "telehealth",
]);
export type AppointmentType = z.infer<typeof appointmentTypeSchema>;

/**
 * Server-authoritative cancel-reason validator (#893).
 *
 * `z.string().trim().min(1)` — whitespace-only reasons are rejected with
 * BAD_REQUEST. The patient-portal UI disables the Confirm button before
 * submit; this check exists so a hand-crafted tRPC call can't sneak an
 * empty reason past the audit trail.
 */
export const cancelReasonSchema = z
  .string()
  .trim()
  .min(1, "Cancel reason is required");

export const cancelAppointmentSchema = z.object({
  appointmentId: z.string(),
  reason: cancelReasonSchema,
});
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;

export const rescheduleAppointmentSchema = z.object({
  appointmentId: z.string(),
  newStartTime: z.string(),
  newEndTime: z.string(),
  reason: cancelReasonSchema,
});
export type RescheduleAppointmentInput = z.infer<
  typeof rescheduleAppointmentSchema
>;
