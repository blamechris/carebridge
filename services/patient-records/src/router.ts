import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { patients, diagnoses, allergies, careTeamMembers } from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const t = initTRPC.create();

export const patientRecordsRouter = t.router({
  create: t.procedure.input(createPatientSchema).mutation(async ({ input }) => {
    const db = getDb();
    const now = new Date().toISOString();
    const patient = { id: crypto.randomUUID(), ...input, created_at: now, updated_at: now };
    await db.insert(patients).values(patient);
    return patient;
  }),

  update: t.procedure
    .input(z.object({ id: z.string().uuid() }).merge(updatePatientSchema))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const db = getDb();
      await db.update(patients).set({ ...data, updated_at: new Date().toISOString() }).where(eq(patients.id, id));
      return { id, ...data };
    }),

  getById: t.procedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const db = getDb();
    const [patient] = await db.select().from(patients).where(eq(patients.id, input.id));
    return patient ?? null;
  }),

  list: t.procedure.query(async () => {
    const db = getDb();
    return db.select().from(patients);
  }),

  // Stub: diagnoses, allergies, care team
  diagnoses: t.router({
    getByPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async ({ input }) => {
      const db = getDb();
      return db.select().from(diagnoses).where(eq(diagnoses.patient_id, input.patientId));
    }),
  }),

  allergies: t.router({
    getByPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async ({ input }) => {
      const db = getDb();
      return db.select().from(allergies).where(eq(allergies.patient_id, input.patientId));
    }),
  }),

  careTeam: t.router({
    getByPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async ({ input }) => {
      const db = getDb();
      return db.select().from(careTeamMembers).where(eq(careTeamMembers.patient_id, input.patientId));
    }),
  }),
});

export type PatientRecordsRouter = typeof patientRecordsRouter;
