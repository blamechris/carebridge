import { z } from "zod";
import { checkInRelationshipSchema } from "./checkins.js";

/**
 * Granular, independently revocable access scopes a patient can grant
 * to a family caregiver.
 */
export const familyAccessScopeSchema = z.enum([
  "view_summary",
  "view_appointments",
  "submit_checkins",
  "view_checkins_history",
  "view_flags",
]);

export type FamilyAccessScope = z.infer<typeof familyAccessScopeSchema>;

/** All available scopes — used as the default when the patient selects "full access". */
export const ALL_FAMILY_SCOPES: FamilyAccessScope[] = [
  "view_summary",
  "view_appointments",
  "submit_checkins",
  "view_checkins_history",
  "view_flags",
];

/**
 * Relationship types valid for a family caregiver grant.
 * Reuses the check-in relationship taxonomy minus "self" and "other".
 */
export const familyRelationshipSchema = z.enum([
  "spouse",
  "adult_child",
  "parent",
  "healthcare_poa",
  "other",
]);

export type FamilyRelationship = z.infer<typeof familyRelationshipSchema>;

/** Patient-initiated invite input. */
export const createFamilyInviteSchema = z.object({
  patient_id: z.string().uuid(),
  invitee_email: z.string().email(),
  relationship: familyRelationshipSchema,
  access_scopes: z.array(familyAccessScopeSchema).min(1),
});

export type CreateFamilyInviteInput = z.infer<typeof createFamilyInviteSchema>;

/** Accept invite input (from the consent landing page). */
export const acceptFamilyInviteSchema = z.object({
  token: z.string().min(1),
  /** Name for the new account (if the user doesn't already exist). */
  name: z.string().min(1).max(200).optional(),
  /** Password for the new account (if the user doesn't already exist). */
  password: z.string().min(8).optional(),
});

export type AcceptFamilyInviteInput = z.infer<typeof acceptFamilyInviteSchema>;

/** Revoke a relationship (by patient or attending clinician). */
export const revokeFamilyAccessSchema = z.object({
  relationship_id: z.string().uuid(),
});

export type RevokeFamilyAccessInput = z.infer<typeof revokeFamilyAccessSchema>;
