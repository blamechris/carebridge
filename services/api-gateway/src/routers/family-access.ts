/**
 * RBAC-enforced family access router.
 *
 * Patients can invite family members to view their health information,
 * revoke active relationships, and cancel pending invites.
 *
 * SECURITY: Both revokeAccess and cancelInvite validate that the caller
 * owns the target relationship/invite before mutating. See issue #305.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import type { Context } from "../context.js";
import {
  createFamilyInvite,
  acceptFamilyInvite,
  revokeFamilyAccess,
  cancelFamilyInvite,
  listFamilyRelationships,
  listFamilyInvites,
} from "@carebridge/auth/family-invite-flow";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

const createInviteSchema = z.object({
  invitee_email: z.string().email(),
  relationship_type: z.enum(["spouse", "parent", "child", "sibling", "other"]),
});

const revokeFamilyAccessSchema = z.object({
  relationship_id: z.string().uuid(),
});

export const familyAccessRbacRouter = t.router({
  /**
   * Send a family access invite. Only patients can invite caregivers.
   */
  createInvite: protectedProcedure
    .input(createInviteSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only patients can invite family members.",
        });
      }

      return createFamilyInvite(
        ctx.user.id,
        input.invitee_email,
        input.relationship_type,
      );
    }),

  /**
   * Accept a family access invite using the invite token.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ invite_token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return acceptFamilyInvite(input.invite_token, ctx.user.id);
    }),

  /**
   * Revoke an active family access relationship.
   *
   * The service layer validates that the caller is either the patient
   * who granted access, the caregiver being revoked, or an admin.
   */
  revokeAccess: protectedProcedure
    .input(revokeFamilyAccessSchema)
    .mutation(async ({ ctx, input }) => {
      await revokeFamilyAccess(
        input.relationship_id,
        ctx.user.id,
        ctx.user.role,
      );
      return { revoked: true };
    }),

  /**
   * Cancel a pending family access invite.
   *
   * The service layer validates that the caller is the patient who
   * created the invite, or an admin.
   */
  cancelInvite: protectedProcedure
    .input(z.object({ invite_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await cancelFamilyInvite(
        input.invite_id,
        ctx.user.id,
        ctx.user.role,
      );
      return { cancelled: true };
    }),

  /**
   * List active family relationships for the current patient.
   */
  listRelationships: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "patient" && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only patients and admins can list family relationships.",
      });
    }
    return listFamilyRelationships(ctx.user.id);
  }),

  /**
   * List pending invites for the current patient.
   */
  listInvites: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "patient" && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only patients and admins can list family invites.",
      });
    }
    return listFamilyInvites(ctx.user.id);
  }),
});
