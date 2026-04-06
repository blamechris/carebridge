/**
 * tRPC router for the AI oversight service.
 *
 * Exposes flag management and review job queries to the API gateway.
 * All flag mutation procedures require authentication — the acting user
 * is derived from the session context, never accepted as client input.
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
    getByPatient: t.procedure
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

    getOpenCount: t.procedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        const count = await flagService.getOpenFlagCount(input.patientId);
        return { count };
      }),
  }),

  reviews: t.router({
    getByPatient: t.procedure
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
