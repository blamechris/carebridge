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
  careTeamAssignments,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import {
  listObservationsByPatient,
  createObservation,
  createDiagnosis,
  updateDiagnosis,
  createAllergy,
  updateAllergy,
} from "@carebridge/patient-records";
import {
  createDiagnosisSchema,
  updateDiagnosisSchema,
  createAllergySchema,
  updateAllergySchema,
} from "@carebridge/validators";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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

/**
 * HIPAA §164.502(b) minimum-necessary column set for patient list endpoints.
 *
 * Excludes insurance_id, emergency_contact_*, and free-text notes — callers
 * that need those fields must use a dedicated endpoint scoped to the use case.
 */
const patientListColumns = {
  id: patients.id,
  name: patients.name,
  date_of_birth: patients.date_of_birth,
  biological_sex: patients.biological_sex,
  diagnosis: patients.diagnosis,
  primary_provider_id: patients.primary_provider_id,
  allergy_status: patients.allergy_status,
  weight_kg: patients.weight_kg,
  mrn: patients.mrn,
  mrn_hmac: patients.mrn_hmac,
  created_at: patients.created_at,
  updated_at: patients.updated_at,
} as const;

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
  //
  // Explicit field selection (HIPAA §164.502(b) minimum necessary): insurance_id,
  // emergency_contact_*, and patient-level free-text notes are intentionally
  // NOT returned here. Callers that need them must use a dedicated endpoint —
  // that scopes the PHI exposure to the use case rather than every getById
  // implicitly leaking billing and contact data to every consumer.
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id);
      const db = getDb();
      const [patient] = await db
        .select({
          id: patients.id,
          name: patients.name,
          date_of_birth: patients.date_of_birth,
          biological_sex: patients.biological_sex,
          diagnosis: patients.diagnosis,
          mrn: patients.mrn,
          mrn_hmac: patients.mrn_hmac,
          primary_provider_id: patients.primary_provider_id,
          allergy_status: patients.allergy_status,
          weight_kg: patients.weight_kg,
          created_at: patients.created_at,
          updated_at: patients.updated_at,
        })
        .from(patients)
        .where(eq(patients.id, input.id));
      return patient ?? null;
    }),

  // Minimum-necessary summary for banner / lookup use cases.
  //
  // Returns only the fields needed to identify a patient — no date-of-birth,
  // no diagnosis, no weight, no billing data. Callers that need richer data
  // should prefer `getById`; callers that only need a name/MRN tile should
  // use this endpoint to avoid incidentally fetching PHI.
  getSummary: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.id);
      const db = getDb();
      const [patient] = await db
        .select({
          id: patients.id,
          name: patients.name,
          mrn: patients.mrn,
        })
        .from(patients)
        .where(eq(patients.id, input.id));
      return patient ?? null;
    }),

  // HIPAA minimum-necessary: filter patient list by role.
  //   - patient: only their own record
  //   - admin: full list
  //   - family_caregiver: only patients linked via an active family_relationships row
  //   - clinician (nurse/physician/specialist): only patients with an active care-team assignment
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();

    // Patients see only their own record.
    if (ctx.user.role === "patient") {
      if (!ctx.user.patient_id) {
        return [];
      }
      return db
        .select(patientListColumns)
        .from(patients)
        .where(eq(patients.id, ctx.user.patient_id));
    }

    // Admins see all patients.
    if (ctx.user.role === "admin") {
      return db.select(patientListColumns).from(patients);
    }

    // Family caregivers: only patients linked via an active family_relationships row.
    if ((ctx.user.role as string) === "family_caregiver") {
      const activeRelationships = await db
        .select({ patient_user_id: familyRelationships.patient_id })
        .from(familyRelationships)
        .where(
          and(
            eq(familyRelationships.caregiver_id, ctx.user.id),
            eq(familyRelationships.status, "active"),
          ),
        );
      if (activeRelationships.length === 0) {
        return [];
      }
      const patientUserIds = activeRelationships.map((r) => r.patient_user_id);
      const linkedUsers = await db
        .select({ patient_id: users.patient_id })
        .from(users)
        .where(
          and(
            inArray(users.id, patientUserIds),
            isNotNull(users.patient_id),
          ),
        );
      const patientRecordIds = linkedUsers
        .map((u) => u.patient_id)
        .filter((id): id is string => Boolean(id));
      if (patientRecordIds.length === 0) {
        return [];
      }
      return db.select(patientListColumns).from(patients).where(inArray(patients.id, patientRecordIds));
    }

    // Clinicians (physician, specialist, nurse): only patients with an
    // active care_team_assignments entry for this user.
    return db
      .select(patientListColumns)
      .from(patients)
      .innerJoin(
        careTeamAssignments,
        eq(patients.id, careTeamAssignments.patient_id),
      )
      .where(
        and(
          eq(careTeamAssignments.user_id, ctx.user.id),
          isNull(careTeamAssignments.removed_at),
        ),
      );
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

    create: protectedProcedure
      .input(createDiagnosisSchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || (ctx.user.role as string) === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot create clinical diagnoses",
          });
        }
        await enforcePatientAccess(ctx.user, input.patient_id);
        return createDiagnosis(input);
      }),

    update: protectedProcedure
      .input(z.object({ id: z.string().uuid() }).merge(updateDiagnosisSchema))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || (ctx.user.role as string) === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot update clinical diagnoses",
          });
        }
        const { id, ...data } = input;
        // Look up the diagnosis to get the patient_id for access check
        const db = getDb();
        const [existing] = await db
          .select()
          .from(diagnoses)
          .where(eq(diagnoses.id, id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Diagnosis ${id} not found` });
        }
        await enforcePatientAccess(ctx.user, existing.patient_id);
        return updateDiagnosis(id, data);
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

    create: protectedProcedure
      .input(createAllergySchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || (ctx.user.role as string) === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot create clinical allergies",
          });
        }
        await enforcePatientAccess(ctx.user, input.patient_id);
        return createAllergy(input);
      }),

    update: protectedProcedure
      .input(z.object({ id: z.string().uuid() }).merge(updateAllergySchema))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient" || (ctx.user.role as string) === "family_caregiver") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Patients cannot update clinical allergies",
          });
        }
        const { id, ...data } = input;
        const db = getDb();
        const [existing] = await db
          .select()
          .from(allergies)
          .where(eq(allergies.id, id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Allergy ${id} not found` });
        }
        await enforcePatientAccess(ctx.user, existing.patient_id);
        return updateAllergy(id, data);
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
