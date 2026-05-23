/**
 * RBAC-enforced Epic-sync router (#391).
 *
 * Layered on top of the raw `epicSyncRouter` exported from
 * @carebridge/epic-connector. All procedures require authentication;
 * `triggerSync` is admin-only (manually re-pulling someone else's patient
 * data is a privileged operation, even with no PHI leak risk).
 * `getSyncStatus` and `listSyncErrors` honour the same care-team RBAC
 * the ai-oversight router uses.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  enqueueFullSync,
  enqueueIncrementalSync,
  enqueueSingleResourceSync,
  getAllSyncStatesForPatient,
  listRecentFailures,
  SUPPORTED_RESOURCE_TYPES,
} from "@carebridge/epic-connector";
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

const isAdmin = isAuthenticated.unstable_pipe(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only admins may trigger Epic sync jobs",
    });
  }
  return next({ ctx });
});
const adminProcedure = t.procedure.use(isAdmin);

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
        message:
          "Access denied: patients may only access their own sync status",
      });
    }
    return;
  }
  const hasAccess = await assertCareTeamAccess(user.id, patientId, clientIp);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

const syncResourceTypeSchema = z.enum(
  SUPPORTED_RESOURCE_TYPES as [string, ...string[]],
);

export const epicSyncRbacRouter = t.router({
  /**
   * Admin-only mutation that enqueues a sync job for a patient.
   */
  triggerSync: adminProcedure
    .input(
      z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("full"),
          patient_id: z.string().uuid(),
          epic_patient_fhir_id: z.string().optional(),
        }),
        z.object({
          mode: z.literal("incremental"),
          patient_id: z.string().uuid(),
          epic_patient_fhir_id: z.string().optional(),
        }),
        z.object({
          mode: z.literal("single"),
          patient_id: z.string().uuid(),
          resource_type: syncResourceTypeSchema,
          epic_patient_fhir_id: z.string().optional(),
          watermark: z.string().nullish(),
        }),
      ]),
    )
    .mutation(async ({ input }) => {
      if (input.mode === "full") {
        await enqueueFullSync({
          patient_id: input.patient_id,
          epic_patient_fhir_id: input.epic_patient_fhir_id,
        });
        return { enqueued: "full-sync" as const, patient_id: input.patient_id };
      }
      if (input.mode === "incremental") {
        await enqueueIncrementalSync({
          patient_id: input.patient_id,
          epic_patient_fhir_id: input.epic_patient_fhir_id,
        });
        return {
          enqueued: "incremental-sync" as const,
          patient_id: input.patient_id,
        };
      }
      await enqueueSingleResourceSync({
        patient_id: input.patient_id,
        resource_type:
          input.resource_type as (typeof SUPPORTED_RESOURCE_TYPES)[number],
        epic_patient_fhir_id: input.epic_patient_fhir_id,
        watermark: input.watermark,
      });
      return {
        enqueued: "single-resource-sync" as const,
        patient_id: input.patient_id,
        resource_type: input.resource_type,
      };
    }),

  /**
   * Read sync status rows for a patient. Care-team RBAC is enforced.
   */
  getSyncStatus: protectedProcedure
    .input(z.object({ patient_id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      await enforcePatientAccess(
        ctx.user,
        input.patient_id,
        ctx.clientIp ?? null,
      );
      return getAllSyncStatesForPatient(input.patient_id);
    }),

  /**
   * Admin-only list of recent sync failures across patients.
   */
  listSyncErrors: adminProcedure
    .input(z.object({ limit: z.number().min(1).max(500).optional() }))
    .query(async ({ input }) => {
      return listRecentFailures(input.limit);
    }),
});
