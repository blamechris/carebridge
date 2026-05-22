import { z } from "zod";

// Clinical roster role (what the chart displays). Mirrors seed data.
export const careTeamMemberRoleSchema = z.enum([
  "primary",
  "specialist",
  "nurse",
  "coordinator",
]);

// RBAC-side assignment role — decoupled from the roster role so a provider
// with clinical role "primary" can carry RBAC role "attending".
export const careTeamAssignmentRoleSchema = z.enum([
  "attending",
  "consulting",
  "nursing",
  "covering",
]);

export const addCareTeamMemberSchema = z.object({
  patient_id: z.string().uuid(),
  provider_id: z.string().uuid(),
  role: careTeamMemberRoleSchema,
  specialty: z.string().max(100).optional(),
  // When present, roster insert + RBAC grant run atomically in one tx.
  assignment_role: careTeamAssignmentRoleSchema.optional(),
});

export const removeCareTeamMemberSchema = z.object({
  member_id: z.string().uuid(),
});

export const updateCareTeamRoleSchema = z.object({
  member_id: z.string().uuid(),
  role: careTeamMemberRoleSchema,
  specialty: z.string().max(100).optional(),
});

export const grantCareTeamAssignmentSchema = z.object({
  user_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  role: careTeamAssignmentRoleSchema,
});

export const revokeCareTeamAssignmentSchema = z.object({
  assignment_id: z.string().uuid(),
});

export type AddCareTeamMemberInput = z.infer<typeof addCareTeamMemberSchema>;
export type RemoveCareTeamMemberInput = z.infer<typeof removeCareTeamMemberSchema>;
export type UpdateCareTeamRoleInput = z.infer<typeof updateCareTeamRoleSchema>;
export type GrantCareTeamAssignmentInput = z.infer<typeof grantCareTeamAssignmentSchema>;
export type RevokeCareTeamAssignmentInput = z.infer<typeof revokeCareTeamAssignmentSchema>;
