import { initTRPC, TRPCError } from "@trpc/server";
import type { User, ServiceContext } from "@carebridge/shared-types";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { patients, diagnoses, allergies, careTeamMembers } from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// tRPC instance with gateway context
// ---------------------------------------------------------------------------

const t = initTRPC.context<ServiceContext>().create();

// ---------------------------------------------------------------------------
// Procedure builders with RBAC
// ---------------------------------------------------------------------------
const CLINICIAN_ROLES: User["role"][] = ["admin", "physician", "specialist", "nurse"];
const ADMIN_ROLES: User["role"][] = ["admin"];

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

const requireAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ADMIN_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This operation requires the admin role.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(authed);
const clinicianProcedure = t.procedure.use(authed).use(requireClinician);
const adminProcedure = t.procedure.use(authed).use(requireAdmin);

/** Assert patient can only see own records. */
function assertPatientAccess(user: User, patientId: string): void {
  if (user.role === "patient" && user.id !== patientId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Patients can only access their own records.",
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const patientRecordsRouter = t.router({
  create: adminProcedure.input(createPatientSchema).mutation(async ({ input }) => {
    const db = getDb();
    const now = new Date().toISOString();
    const patient = { id: crypto.randomUUID(), ...input, created_at: now, updated_at: now };
    await db.insert(patients).values(patient);
    return patient;
  }),

  update: adminProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updatePatientSchema))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const db = getDb();
      await db.update(patients).set({ ...data, updated_at: new Date().toISOString() }).where(eq(patients.id, id));
      return { id, ...data };
    }),

  getById: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    assertPatientAccess(ctx.user, input.id);
    const db = getDb();
    const [patient] = await db.select().from(patients).where(eq(patients.id, input.id));
    return patient ?? null;
  }),

  list: clinicianProcedure.query(async () => {
    const db = getDb();
    return db.select().from(patients);
  }),

  diagnoses: t.router({
    getByPatient: protectedProcedure.input(z.object({ patientId: z.string().uuid() })).query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      const db = getDb();
      return db.select().from(diagnoses).where(eq(diagnoses.patient_id, input.patientId));
    }),
  }),

  allergies: t.router({
    getByPatient: protectedProcedure.input(z.object({ patientId: z.string().uuid() })).query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      const db = getDb();
      return db.select().from(allergies).where(eq(allergies.patient_id, input.patientId));
    }),
  }),

  careTeam: t.router({
    getByPatient: protectedProcedure.input(z.object({ patientId: z.string().uuid() })).query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      const db = getDb();
      return db.select().from(careTeamMembers).where(eq(careTeamMembers.patient_id, input.patientId));
    }),
  }),
});

export type PatientRecordsRouter = typeof patientRecordsRouter;
