/**
 * Phase B3 — family caregiver access RBAC router.
 *
 * Patient-initiated path only. Patients can:
 *   - Invite a family member (creates a pending invite)
 *   - List their active family relationships
 *   - List pending invites they've sent
 *   - Revoke a family member's access
 *   - Cancel a pending invite
 *
 * The accept-invite endpoint is public (token-authenticated, not
 * session-authenticated) because the invitee may not have an account yet.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import {
  createFamilyInvite,
  acceptFamilyInvite,
  revokeFamilyAccess,
  cancelFamilyInvite,
  listFamilyRelationships,
  listPendingInvites,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyAcceptedError,
  AccountRequiredError,
} from "@carebridge/auth";
import {
  createFamilyInviteSchema,
  acceptFamilyInviteSchema,
  revokeFamilyAccessSchema,
} from "@carebridge/validators";
import type { Context } from "../context.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

export const familyAccessRouter = t.router({
  /**
   * Patient creates an invite for a family member.
   */
  createInvite: protectedProcedure
    .input(createFamilyInviteSchema)
    .mutation(async ({ ctx, input }) => {
      // Only the patient themselves can invite family members.
      if (ctx.user.role !== "patient" || ctx.user.id !== input.patient_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only patients can invite family caregivers to their own record",
        });
      }

      const result = await createFamilyInvite({
        patient_id: input.patient_id,
        invited_by_user_id: ctx.user.id,
        invitee_email: input.invitee_email,
        relationship: input.relationship,
        access_scopes: input.access_scopes,
      });

      return result;
    }),

  /**
   * Accept an invite using the token from the invite link.
   * This endpoint is public — the invitee authenticates via the token.
   */
  acceptInvite: t.procedure
    .input(acceptFamilyInviteSchema)
    .mutation(async ({ input }) => {
      try {
        return await acceptFamilyInvite(input);
      } catch (err) {
        if (err instanceof InviteNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: err.message,
          });
        }
        if (err instanceof InviteExpiredError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err.message,
          });
        }
        if (err instanceof InviteAlreadyAcceptedError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: err.message,
          });
        }
        if (err instanceof AccountRequiredError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err.message,
          });
        }
        throw err;
      }
    }),

  /**
   * List active family relationships for the logged-in patient.
   */
  listRelationships: protectedProcedure
    .input(z.object({ patient_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "patient" || ctx.user.id !== input.patient_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Patients can only view their own family relationships",
        });
      }
      return listFamilyRelationships(input.patient_id);
    }),

  /**
   * List pending invites sent by the logged-in patient.
   */
  listPendingInvites: protectedProcedure
    .input(z.object({ patient_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "patient" || ctx.user.id !== input.patient_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Patients can only view their own pending invites",
        });
      }
      return listPendingInvites(input.patient_id);
    }),

  /**
   * Revoke a family member's access. Patients can revoke relationships
   * on their own record.
   */
  revokeAccess: protectedProcedure
    .input(revokeFamilyAccessSchema)
    .mutation(async ({ ctx, input }) => {
      // For now, only patients can revoke. Phase B3 proxy will extend
      // this to attending clinicians.
      if (ctx.user.role !== "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only patients can revoke family caregiver access",
        });
      }
      await revokeFamilyAccess(input.relationship_id, ctx.user.id);
      return { success: true };
    }),

  /**
   * Cancel a pending invite. Only the inviting patient can cancel.
   */
  cancelInvite: protectedProcedure
    .input(z.object({ invite_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only patients can cancel their own invites",
        });
      }
      await cancelFamilyInvite(input.invite_id);
      return { success: true };
    }),
});
