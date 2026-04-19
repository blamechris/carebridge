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
  clientIp?: string | null,
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

  // clientIp flows through to the emergency_access_used audit row for
  // HIPAA § 164.312(b) completeness.
  const hasAccess = await assertCareTeamAccess(user.id, patientId, clientIp);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

// Delegate to the underlying fhir-gateway router. The raw router now
// requires an authenticated user in its own context as defense-in-depth
// (see services/fhir-gateway/src/router.ts), so we thread ctx.user through
// on every call rather than using a single module-level caller.
export const fhirRbacRouter = t.router({
  exportPatient: protectedProcedure
    .input(z.object({ patientId: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, ctx.clientIp);
      const caller = fhirGatewayRouter.createCaller({
        user: ctx.user,
        rbacVerified: true,
        setHeader: ctx.setHeader,
      });
      return caller.exportPatient(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string(), resourceType: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, ctx.clientIp);
      const caller = fhirGatewayRouter.createCaller({ user: ctx.user, rbacVerified: true });
      return caller.getByPatient(input);
    }),

  importBundle: protectedProcedure
    .input(
      z.object({
        bundle: fhirBundleSchema,
        source_system: z.string(),
        bundle_id: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: importBundle requires admin role",
        });
      }
      // Build a per-request caller with typed ctx so the raw router's
      // auth middleware sees the authenticated user (PR #273 / #379), AND
      // forward the caller's user id in the input so the fhir-gateway can
      // attribute its per-resource audit_log entries to the admin
      // performing the import (PR #274 / #378, HIPAA § 164.312(b)).
      const caller = fhirGatewayRouter.createCaller({ user: ctx.user });
      return caller.importBundle({
        ...input,
        user_id: ctx.user.id,
      });
    }),
});
