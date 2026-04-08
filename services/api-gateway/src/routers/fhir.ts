/**
 * RBAC-enforced FHIR gateway router.
 *
 * Wraps the standalone @carebridge/fhir-gateway router procedures with
 * authentication and HIPAA minimum-necessary access checks.
 *
 * - exportPatient / getByPatient: require auth + enforcePatientAccess
 * - importBundle: admin-only
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { fhirGatewayRouter, fhirBundleSchema } from "@carebridge/fhir-gateway";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

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

  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

// Delegate to the underlying fhir-gateway router via a context-less caller.
const fhirCaller = fhirGatewayRouter.createCaller({});

export const fhirRbacRouter = t.router({
  exportPatient: protectedProcedure
    .input(z.object({ patientId: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return fhirCaller.exportPatient(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string(), resourceType: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return fhirCaller.getByPatient(input);
    }),

  importBundle: protectedProcedure
    .input(
      z.object({
        bundle: fhirBundleSchema,
        source_system: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: importBundle requires admin role",
        });
      }
      return fhirCaller.importBundle(input);
    }),
});
