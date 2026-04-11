/**
 * RBAC-enforced patient-records router.
 *
 * Patient-scoped read/write procedures call enforcePatientAccess() before
 * querying the database.
 *
 * Administrative procedures (create, list) are restricted to non-patient roles.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import {
  getDb,
  hmacForIndex,
  patients,
  diagnoses,
  allergies,
  careTeamMembers,
} from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import {
  listObservationsByPatient,
  createObservation,
} from "@carebridge/patient-records";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
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

export const patientRecordsRbacRouter = t.router({
  // Administrative: creating a patient record is restricted to non-patient roles.
  create: protectedProcedure
    .input(createPatientSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Patients cannot create patient records",
        });
      }
      const db = getDb();
      const now = new Date().toISOString();
      const mrn_hmac = input.mrn ? hmacForIndex(input.mrn) : undefined;
      const patient = {
        id: crypto.randomUUID(),
        ...input,
        mrn_hmac,
        created_at: now,
        updated_at: now,
      };
      await db.insert(patients).values(patient);
      return patient;
    }),

  // Updating a patient record is patient-scoped: input.id is the patientId.
  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updatePatientSchema))
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id);
      const { id, ...data } = input;
      const db = getDb();
      const mrn_hmac =
        data.mrn !== undefined ? (data.mrn ? hmacForIndex(data.mrn) : null) : undefined;
      const updates = {
        ...data,
        ...(mrn_hmac !== undefined ? { mrn_hmac } : {}),
        updated_at: new Date().toISOString(),
      };
      await db.update(patients).set(updates).where(eq(patients.id, id));
      return { id, ...data };
    }),

  // Reading a specific patient record is patient-scoped: input.id is the patientId.
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id);
      const db = getDb();
      const [patient] = await db
        .select()
        .from(patients)
        .where(eq(patients.id, input.id));
      return patient ?? null;
    }),

  // Listing all patients is restricted to non-patient roles.
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "patient") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Patients cannot list all patient records",
      });
    }
    const db = getDb();
    return db.select().from(patients);
  }),

  diagnoses: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        const db = getDb();
        return db
          .select()
          .from(diagnoses)
          .where(eq(diagnoses.patient_id, input.patientId));
      }),
  }),

  allergies: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        const db = getDb();
        return db
          .select()
          .from(allergies)
          .where(eq(allergies.patient_id, input.patientId));
      }),
  }),

  careTeam: t.router({
    getByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        const db = getDb();
        return db
          .select()
          .from(careTeamMembers)
          .where(eq(careTeamMembers.patient_id, input.patientId));
      }),
  }),

  observations: t.router({
    getByPatient: protectedProcedure
      .input(
        z.object({
          patientId: z.string(),
          limit: z.number().optional().default(20),
        }),
      )
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        return listObservationsByPatient(input.patientId, input.limit);
      }),

    create: protectedProcedure
      .input(
        z.object({
          patientId: z.string(),
          observationType: z.enum([
            "pain",
            "neurological",
            "gastrointestinal",
            "respiratory",
            "skin",
            "cardiovascular",
            "general",
            "medication_side_effect",
          ]),
          description: z.string().min(1),
          structuredData: z
            .object({
              location: z.string().optional(),
              severity: z.number().min(1).max(10),
              duration: z.string().optional(),
              frequency: z.string().optional(),
              associated_activities: z.string().optional(),
            })
            .optional(),
          severitySelfAssessment: z
            .enum(["mild", "moderate", "severe"])
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
        return createObservation(input);
      }),
  }),
});
