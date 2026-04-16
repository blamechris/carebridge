import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb, hmacForIndex } from "@carebridge/db-schema";
import { patients, diagnoses, allergies, careTeamMembers, patientObservations } from "@carebridge/db-schema";
import {
  createPatientSchema,
  updatePatientSchema,
  createDiagnosisSchema,
  updateDiagnosisSchema,
  createAllergySchema,
  updateAllergySchema,
} from "@carebridge/validators";
import { eq, desc } from "drizzle-orm";
import { Queue } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import crypto from "node:crypto";

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
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

  diagnoses: t.router({
    getByPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async ({ input }) => {
      const db = getDb();
      return db.select().from(diagnoses).where(eq(diagnoses.patient_id, input.patientId));
    }),
    create: t.procedure.input(createDiagnosisSchema).mutation(async ({ input }) => {
      return createDiagnosis(input);
    }),
    update: t.procedure
      .input(z.object({ id: z.string().uuid() }).merge(updateDiagnosisSchema))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return updateDiagnosis(id, data);
      }),
  }),

  allergies: t.router({
    getByPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async ({ input }) => {
      const db = getDb();
      return db.select().from(allergies).where(eq(allergies.patient_id, input.patientId));
    }),
    create: t.procedure.input(createAllergySchema).mutation(async ({ input }) => {
      return createAllergy(input);
    }),
    update: t.procedure
      .input(z.object({ id: z.string().uuid() }).merge(updateAllergySchema))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return updateAllergy(id, data);
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

// ---------------------------------------------------------------------------
// Diagnosis helpers
// ---------------------------------------------------------------------------

export async function createDiagnosis(input: z.infer<typeof createDiagnosisSchema>) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const record = {
    id,
    patient_id: input.patient_id,
    icd10_code: input.icd10_code,
    description: input.description,
    status: input.status ?? "active",
    onset_date: input.onset_date ?? null,
    snomed_code: input.snomed_code ?? null,
    created_at: now,
  };

  await db.insert(diagnoses).values(record);

  await clinicalEventsQueue.add("diagnosis.added", {
    id: crypto.randomUUID(),
    type: "diagnosis.added",
    patient_id: input.patient_id,
    data: { diagnosis_id: id, icd10_code: input.icd10_code, status: record.status },
    timestamp: now,
  });

  return record;
}

export async function updateDiagnosis(
  id: string,
  input: z.infer<typeof updateDiagnosisSchema>,
) {
  const db = getDb();
  const now = new Date().toISOString();

  const [existing] = await db.select().from(diagnoses).where(eq(diagnoses.id, id)).limit(1);
  if (!existing) {
    throw new Error(`Diagnosis ${id} not found`);
  }

  const updates: Record<string, unknown> = {};
  if (input.status !== undefined) {
    updates.status = input.status;
    // Populate resolved_date for FHIR Condition export and patient portal display
    if (input.status === "resolved") {
      updates.resolved_date = now;
    } else if (existing.status === "resolved") {
      // Transitioning away from resolved — clear the date
      updates.resolved_date = null;
    }
  }
  if (input.description !== undefined) updates.description = input.description;

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  await db.update(diagnoses).set(updates).where(eq(diagnoses.id, id));

  await clinicalEventsQueue.add("diagnosis.updated", {
    id: crypto.randomUUID(),
    type: "diagnosis.updated",
    patient_id: existing.patient_id,
    data: { diagnosis_id: id, changedFields: Object.keys(updates) },
    timestamp: now,
  });

  const [updated] = await db.select().from(diagnoses).where(eq(diagnoses.id, id)).limit(1);
  return updated;
}

// ---------------------------------------------------------------------------
// Allergy helpers
// ---------------------------------------------------------------------------

export async function createAllergy(input: z.infer<typeof createAllergySchema>) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const record = {
    id,
    patient_id: input.patient_id,
    allergen: input.allergen,
    reaction: input.reaction,
    severity: input.severity,
    verification_status: input.verification_status ?? "unconfirmed",
    created_at: now,
  };

  await db.insert(allergies).values(record);

  await clinicalEventsQueue.add("allergy.added", {
    id: crypto.randomUUID(),
    type: "allergy.added",
    patient_id: input.patient_id,
    data: { allergy_id: id, allergen: input.allergen, severity: input.severity, verification_status: record.verification_status },
    timestamp: now,
  });

  return record;
}

export async function updateAllergy(
  id: string,
  input: z.infer<typeof updateAllergySchema>,
) {
  const db = getDb();
  const now = new Date().toISOString();

  const [existing] = await db.select().from(allergies).where(eq(allergies.id, id)).limit(1);
  if (!existing) {
    throw new Error(`Allergy ${id} not found`);
  }

  const updates: Record<string, unknown> = {};
  if (input.severity !== undefined) updates.severity = input.severity;
  if (input.reaction !== undefined) updates.reaction = input.reaction;
  if (input.verification_status !== undefined) updates.verification_status = input.verification_status;

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  await db.update(allergies).set(updates).where(eq(allergies.id, id));

  await clinicalEventsQueue.add("allergy.updated", {
    id: crypto.randomUUID(),
    type: "allergy.updated",
    patient_id: existing.patient_id,
    data: { allergy_id: id, changedFields: Object.keys(updates) },
    timestamp: now,
  });

  const [updated] = await db.select().from(allergies).where(eq(allergies.id, id)).limit(1);
  return updated;
}

export type PatientRecordsRouter = typeof patientRecordsRouter;
