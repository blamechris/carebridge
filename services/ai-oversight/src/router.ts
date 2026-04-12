/**
 * tRPC router for the AI oversight service.
 *
 * The api-gateway mounts flag and review-job queries via the RBAC wrapper in
 * `services/api-gateway/src/routers/ai-oversight.ts`, not this module. This
 * router is retained for internal / test use and defence-in-depth: every
 * procedure requires authentication so a direct mount would still deny
 * anonymous callers. Patient-scoped authorisation, however, is enforced only
 * by the RBAC wrapper — do not register this router on an external surface.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import { reviewJobs } from "@carebridge/db-schema";
import type { User } from "@carebridge/shared-types";
import {
  flagStatusSchema,
} from "@carebridge/validators";

import * as flagService from "./services/flag-service.js";

export interface Context {
  user: User | null;
}

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource.",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

export const aiOversightRouter = t.router({
  flags: t.router({
    getByPatient: protectedProcedure
      .input(
        z.object({
          patientId: z.string().uuid(),
          status: flagStatusSchema.optional(),
        }),
      )
      .query(async ({ input }) => {
        return flagService.getFlagsByPatient(input.patientId, input.status);
      }),

    acknowledge: protectedProcedure
      .input(
        z.object({
          flagId: z.string().uuid(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
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
      .mutation(async ({ input, ctx }) => {
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
      .mutation(async ({ input, ctx }) => {
        await flagService.dismissFlag(
          input.flagId,
          ctx.user.id,
          input.dismiss_reason,
        );
        return { success: true };
      }),

    getAllOpen: protectedProcedure
      .query(async () => {
        return flagService.getAllOpenFlags();
      }),

    getOpenCount: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        const count = await flagService.getOpenFlagCount(input.patientId);
        return { count };
      }),
  }),

  reviews: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        const db = getDb();
        const jobs = await db
          .select()
          .from(reviewJobs)
          .where(eq(reviewJobs.patient_id, input.patientId))
          .orderBy(desc(reviewJobs.created_at));
        return jobs;
      }),
  }),
});

export type AiOversightRouter = typeof aiOversightRouter;
