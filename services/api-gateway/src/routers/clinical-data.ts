/**
 * RBAC-enforced clinical-data router.
 *
 * Every patient-scoped procedure calls enforcePatientAccess() before
 * delegating to the underlying repository functions from @carebridge/clinical-data.
 *
 * Procedures where the patient must be resolved from another resource id
 * (medications.update, medications.logAdmin) perform a lightweight DB lookup
 * to obtain the patient_id before running the access check.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import {
  createVitalSchema,
  vitalTypeSchema,
  createLabPanelSchema,
  createMedicationSchema,
  updateMedicationSchema,
  medStatusSchema,
  createProcedureSchema,
} from "@carebridge/validators";
import {
  vitalRepo,
  labRepo,
  medicationRepo,
  procedureRepo,
  ConflictError,
} from "@carebridge/clinical-data";
import {
  getDb,
  medications,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { and, eq } from "drizzle-orm";
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

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair.
 * Throws TRPCError(FORBIDDEN) on denial.
 *
 * Role semantics mirror patient-records.ts — family_caregiver resolves via
 * an active family_relationships row joined through users.patient_id.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    const ownRecord = user.patient_id ?? user.id;
    if (ownRecord !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  if (user.role === "family_caregiver") {
    const db = getDb();
    const [row] = await db
      .select({ id: familyRelationships.id })
      .from(familyRelationships)
      .innerJoin(users, eq(users.id, familyRelationships.patient_id))
      .where(
        and(
          eq(familyRelationships.caregiver_id, user.id),
          eq(users.patient_id, patientId),
          eq(familyRelationships.status, "active"),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Access denied: no active family relationship grants access to this patient",
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

// ─── Vitals ──────────────────────────────────────────────────────────────────

const vitalsRouter = t.router({
  create: protectedProcedure
    .input(createVitalSchema)
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patient_id);
      return vitalRepo.createVital(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), type: vitalTypeSchema.optional() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return vitalRepo.getVitalsByPatient(input.patientId, input.type);
    }),

  getLatest: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return vitalRepo.getLatestVitals(input.patientId);
    }),
});

// ─── Labs ─────────────────────────────────────────────────────────────────────

const labsRouter = t.router({
  createPanel: protectedProcedure
    .input(createLabPanelSchema)
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patient_id);
      return labRepo.createLabPanel(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return labRepo.getLabPanelsByPatient(input.patientId);
    }),

  getHistory: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), testName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return labRepo.getLabResultHistory(input.patientId, input.testName);
    }),
});

// ─── Medications ──────────────────────────────────────────────────────────────

const medicationsRouter = t.router({
  create: protectedProcedure
    .input(createMedicationSchema)
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patient_id);
      return medicationRepo.createMedication(input);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateMedicationSchema))
    .mutation(async ({ ctx, input }) => {
      // Resolve patientId from the medication record before checking access.
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: medications.patient_id })
        .from(medications)
        .where(eq(medications.id, input.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Medication ${input.id} not found` });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id);

      const { id, ...rest } = input;
      try {
        return await medicationRepo.updateMedication(id, rest);
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), status: medStatusSchema.optional() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return medicationRepo.getMedicationsByPatient(input.patientId, input.status);
    }),

  logAdmin: protectedProcedure
    .input(
      z.object({
        medicationId: z.string().uuid(),
        administeredAt: z.string().datetime(),
        doseAmount: z.number().positive().optional(),
        doseUnit: z.string().max(20).optional(),
        administeredBy: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve patientId from the medication before checking access.
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: medications.patient_id })
        .from(medications)
        .where(eq(medications.id, input.medicationId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Medication ${input.medicationId} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id);

      return medicationRepo.logAdministration(
        input.medicationId,
        input.administeredAt,
        input.doseAmount,
        input.doseUnit,
        input.administeredBy,
      );
    }),
});

// ─── Procedures ───────────────────────────────────────────────────────────────

const proceduresRouter = t.router({
  create: protectedProcedure
    .input(createProcedureSchema)
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patient_id);
      return procedureRepo.createProcedure(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return procedureRepo.getProceduresByPatient(input.patientId);
    }),
});

// ─── Composed router ──────────────────────────────────────────────────────────

export const clinicalDataRbacRouter = t.router({
  vitals: vitalsRouter,
  labs: labsRouter,
  medications: medicationsRouter,
  procedures: proceduresRouter,
});
