/**
 * tRPC router for the AI oversight service.
 *
 * Exposes flag management and review job queries to the API gateway.
 * All operations restricted to clinical staff (physician, specialist, nurse, admin).
 */

import { initTRPC, TRPCError } from "@trpc/server";
import type { User, ServiceContext } from "@carebridge/shared-types";
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

// ---------------------------------------------------------------------------
// tRPC instance with gateway context
// ---------------------------------------------------------------------------

const t = initTRPC.context<ServiceContext>().create();

// ---------------------------------------------------------------------------
// Procedure builders with RBAC
// ---------------------------------------------------------------------------
const CLINICIAN_ROLES: User["role"][] = ["admin", "physician", "specialist", "nurse"];

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required." });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireClinician = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !CLINICIAN_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This operation requires one of the following roles: ${CLINICIAN_ROLES.join(", ")}.`,
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const clinicianProcedure = t.procedure.use(authed).use(requireClinician);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const aiOversightRouter = t.router({
  flags: t.router({
    getByPatient: clinicianProcedure
      .input(
        z.object({
          patientId: z.string().uuid(),
          status: flagStatusSchema.optional(),
        }),
      )
      .query(async ({ input }) => {
        return flagService.getFlagsByPatient(input.patientId, input.status);
      }),

    acknowledge: clinicianProcedure
      .input(
        z.object({
          flagId: z.string().uuid(),
        }).merge(acknowledgeFlagSchema),
      )
      .mutation(async ({ input }) => {
        await flagService.acknowledgeFlag(input.flagId, input.acknowledged_by);
        return { success: true };
      }),

    resolve: clinicianProcedure
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

    dismiss: clinicianProcedure
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

    getOpenCount: clinicianProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        const count = await flagService.getOpenFlagCount(input.patientId);
        return { count };
      }),
  }),

  reviews: t.router({
    getByPatient: clinicianProcedure
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
