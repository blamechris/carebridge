/**
 * tRPC router for the AI oversight service.
 *
 * Exposes flag management and review job queries to the API gateway.
 */

import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import { reviewJobs } from "@carebridge/db-schema";
import {
  acknowledgeFlagSchema,
  resolveFlagSchema,
  dismissFlagSchema,
  flagStatusSchema,
} from "@carebridge/validators";

import * as flagService from "./services/flag-service.js";

const t = initTRPC.create();

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

    acknowledge: t.procedure
      .input(
        z.object({
          flagId: z.string().uuid(),
        }).merge(acknowledgeFlagSchema),
      )
      .mutation(async ({ input }) => {
        await flagService.acknowledgeFlag(input.flagId, input.acknowledged_by);
        return { success: true };
      }),

    resolve: t.procedure
      .input(
        z.object({
          flagId: z.string().uuid(),
        }).merge(resolveFlagSchema),
      )
      .mutation(async ({ input }) => {
        await flagService.resolveFlag(
          input.flagId,
          input.resolved_by,
          input.resolution_note,
        );
        return { success: true };
      }),

    dismiss: t.procedure
      .input(
        z.object({
          flagId: z.string().uuid(),
        }).merge(dismissFlagSchema),
      )
      .mutation(async ({ input }) => {
        await flagService.dismissFlag(
          input.flagId,
          input.dismissed_by,
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
