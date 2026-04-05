import { initTRPC, TRPCError } from "@trpc/server";
import type { User, ServiceContext } from "@carebridge/shared-types";
import { z } from "zod";
import {
  createVitalSchema,
  vitalTypeSchema,
  createLabPanelSchema,
  createMedicationSchema,
  updateMedicationSchema,
  medStatusSchema,
  createProcedureSchema,
} from "@carebridge/validators";
import * as vitalRepo from "./repositories/vital-repo.js";
import * as labRepo from "./repositories/lab-repo.js";
import * as medicationRepo from "./repositories/medication-repo.js";
import * as procedureRepo from "./repositories/procedure-repo.js";

// ---------------------------------------------------------------------------
// tRPC instance with gateway context (user is resolved by api-gateway auth)
// ---------------------------------------------------------------------------

const t = initTRPC.context<ServiceContext>().create();

// ---------------------------------------------------------------------------
// Procedure builders with RBAC
// ---------------------------------------------------------------------------
const CLINICAL_WRITER_ROLES: User["role"][] = ["admin", "physician", "specialist", "nurse"];

/** Requires an authenticated session. */
const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required." });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Requires clinical write role (physician, specialist, nurse, admin). */
const requireClinicalWrite = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !CLINICAL_WRITER_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical data modifications require a clinical staff role.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(authed);
const clinicalWriteProcedure = t.procedure.use(authed).use(requireClinicalWrite);

/** Assert patient can only see own records. Clinicians may see any patient. */
function assertPatientAccess(user: User, patientId: string): void {
  if (user.role === "patient" && user.id !== patientId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Patients can only access their own records.",
    });
  }
}

// ---------------------------------------------------------------------------
// Sub-routers
// ---------------------------------------------------------------------------
const vitalsRouter = t.router({
  create: clinicalWriteProcedure
    .input(createVitalSchema)
    .mutation(async ({ input }) => {
      return vitalRepo.createVital(input);
    }),

  getByPatient: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        type: vitalTypeSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return vitalRepo.getVitalsByPatient(input.patientId, input.type);
    }),

  getLatest: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return vitalRepo.getLatestVitals(input.patientId);
    }),
});

const labsRouter = t.router({
  createPanel: clinicalWriteProcedure
    .input(createLabPanelSchema)
    .mutation(async ({ input }) => {
      return labRepo.createLabPanel(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return labRepo.getLabPanelsByPatient(input.patientId);
    }),

  getHistory: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        testName: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return labRepo.getLabResultHistory(input.patientId, input.testName);
    }),
});

const medicationsRouter = t.router({
  create: clinicalWriteProcedure
    .input(createMedicationSchema)
    .mutation(async ({ input }) => {
      return medicationRepo.createMedication(input);
    }),

  update: clinicalWriteProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateMedicationSchema))
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      return medicationRepo.updateMedication(id, rest);
    }),

  getByPatient: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        status: medStatusSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return medicationRepo.getMedicationsByPatient(input.patientId, input.status);
    }),

  logAdmin: clinicalWriteProcedure
    .input(
      z.object({
        medicationId: z.string().uuid(),
        administeredAt: z.string().datetime(),
        doseAmount: z.number().positive().optional(),
        doseUnit: z.string().max(20).optional(),
        administeredBy: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return medicationRepo.logAdministration(
        input.medicationId,
        input.administeredAt,
        input.doseAmount,
        input.doseUnit,
        input.administeredBy,
      );
    }),
});

const proceduresRouter = t.router({
  create: clinicalWriteProcedure
    .input(createProcedureSchema)
    .mutation(async ({ input }) => {
      return procedureRepo.createProcedure(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return procedureRepo.getProceduresByPatient(input.patientId);
    }),
});

export const clinicalDataRouter = t.router({
  vitals: vitalsRouter,
  labs: labsRouter,
  medications: medicationsRouter,
  procedures: proceduresRouter,
});

export type ClinicalDataRouter = typeof clinicalDataRouter;
