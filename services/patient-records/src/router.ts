import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb, hmacForIndex } from "@carebridge/db-schema";
import { patients, diagnoses, allergies, careTeamMembers, patientObservations } from "@carebridge/db-schema";
import { createPatientSchema, updatePatientSchema } from "@carebridge/validators";
import { eq, desc } from "drizzle-orm";
import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import crypto from "node:crypto";

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

const t = initTRPC.create();

export const patientRecordsRouter = t.router({
  create: t.procedure.input(createPatientSchema).mutation(async ({ input }) => {
    const db = getDb();
    const now = new Date().toISOString();
    const mrn_hmac = input.mrn ? hmacForIndex(input.mrn) : undefined;
    const patient = { id: crypto.randomUUID(), ...input, mrn_hmac, created_at: now, updated_at: now };
    await db.insert(patients).values(patient);
    return patient;
  }),

  update: t.procedure
    .input(z.object({ id: z.string().uuid() }).merge(updatePatientSchema))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const db = getDb();
      const mrn_hmac = data.mrn !== undefined ? (data.mrn ? hmacForIndex(data.mrn) : null) : undefined;
      const updates = { ...data, ...(mrn_hmac !== undefined ? { mrn_hmac } : {}), updated_at: new Date().toISOString() };
      await db.update(patients).set(updates).where(eq(patients.id, id));
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

  observations: t.router({
    /** List observations for a patient, most recent first. */
    getByPatient: t.procedure
      .input(z.object({ patientId: z.string(), limit: z.number().optional().default(20) }))
      .query(({ input }) => listObservationsByPatient(input.patientId, input.limit)),

    /** Create a new patient observation. Emits patient.observation event for AI oversight. */
    create: t.procedure
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
          severitySelfAssessment: z.enum(["mild", "moderate", "severe"]).optional(),
        }),
      )
      .mutation(({ input }) => createObservation(input)),
  }),
});

// ---------------------------------------------------------------------------
// Observation service helpers — exported for the api-gateway RBAC wrapper.
// The raw `observations` sub-router stays here for backward compatibility,
// but the gateway wrapper now imports the helper functions directly so it can
// run enforcePatientAccess() before delegating to the persistence layer.
// ---------------------------------------------------------------------------

export const observationCreateSchema = z.object({
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
  severitySelfAssessment: z.enum(["mild", "moderate", "severe"]).optional(),
});

export type ObservationCreateInput = z.infer<typeof observationCreateSchema>;

export async function listObservationsByPatient(
  patientId: string,
  limit = 20,
) {
  const db = getDb();
  return db
    .select()
    .from(patientObservations)
    .where(eq(patientObservations.patient_id, patientId))
    .orderBy(desc(patientObservations.created_at))
    .limit(limit);
}

export async function createObservation(input: ObservationCreateInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const observation = {
    id,
    patient_id: input.patientId,
    observation_type: input.observationType,
    description: input.description,
    structured_data: input.structuredData ?? null,
    severity_self_assessment: input.severitySelfAssessment ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(patientObservations).values(observation);

  // Emit patient.observation event for AI oversight screening.
  // IMPORTANT: Do NOT include description (PHI) in the event payload.
  // The AI oversight worker reads the observation from DB where Drizzle
  // handles transparent decryption of the encrypted description field.
  await clinicalEventsQueue.add("patient.observation", {
    id: crypto.randomUUID(),
    type: "patient.observation",
    patient_id: input.patientId,
    data: {
      observation_id: id,
      observation_type: input.observationType,
      severity_self_assessment: input.severitySelfAssessment,
    },
    timestamp: now,
  });

  return observation;
}

export type PatientRecordsRouter = typeof patientRecordsRouter;
