/**
 * RBAC-enforced ai-oversight router.
 *
 * Every patient-scoped procedure calls enforcePatientAccess() before
 * delegating to the flag service functions from @carebridge/ai-oversight.
 * userId is derived from ctx.user.id — never accepted as client input.
 *
 * Closes the IDOR in the raw ai-oversight router (issue #270) where
 * flags.getByPatient, flags.getOpenCount and reviews.getByPatient were
 * previously exposed as unauthenticated tRPC procedures.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { flagStatusSchema } from "@carebridge/validators";
import {
  flagService,
  getReviewJobsByPatient,
} from "@carebridge/ai-oversight";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

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

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair.
 * Throws TRPCError(FORBIDDEN) on denial.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    if (user.id !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

export const aiOversightRbacRouter = t.router({
  flags: t.router({
    getByPatient: protectedProcedure
      .input(
        z.object({
          patientId: z.string().uuid(),
          status: flagStatusSchema.optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        return flagService.getFlagsByPatient(input.patientId, input.status);
      }),

    getOpenCount: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        const count = await flagService.getOpenFlagCount(input.patientId);
        return { count };
      }),

    getAllOpen: protectedProcedure.query(async ({ ctx }) => {
      // Patients are never allowed to enumerate the global open-flag inbox.
      if (ctx.user.role === "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: patients cannot list the clinician inbox",
        });
      }
      return flagService.getAllOpenFlags();
    }),

    acknowledge: protectedProcedure
      .input(z.object({ flagId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await flagService.acknowledgeFlag(input.flagId, ctx.user.id);
        return { success: true };
      }),

    resolve: protectedProcedure
      .input(
        z.object({
          flagId: z.string().uuid(),
          resolution_note: z.string().min(1).max(2000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await flagService.resolveFlag(
          input.flagId,
          ctx.user.id,
          input.resolution_note,
        );
        return { success: true };
      }),

    dismiss: protectedProcedure
      .input(
        z.object({
          flagId: z.string().uuid(),
          dismiss_reason: z.string().min(1).max(2000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await flagService.dismissFlag(
          input.flagId,
          ctx.user.id,
          input.dismiss_reason,
        );
        return { success: true };
      }),
  }),

  reviews: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        return getReviewJobsByPatient(input.patientId);
      }),
  }),
});

export type AiOversightRbacRouter = typeof aiOversightRbacRouter;
