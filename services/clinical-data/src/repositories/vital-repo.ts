import { eq, and, desc } from "drizzle-orm";
import { getDb, vitals } from "@carebridge/db-schema";
import type { CreateVitalInput } from "@carebridge/validators";
import type { Vital, VitalType } from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Inserts a new vital record and emits a "vital.created" event.
 */
export async function createVital(input: CreateVitalInput): Promise<Vital> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const record: typeof vitals.$inferInsert = {
    id,
    patient_id: input.patient_id,
    recorded_at: input.recorded_at,
    type: input.type,
    value_primary: input.value_primary,
    value_secondary: input.value_secondary ?? null,
    unit: input.unit,
    notes: input.notes ?? null,
    provider_id: input.provider_id ?? null,
    encounter_id: input.encounter_id ?? null,
    created_at: now,
  };

  await db.insert(vitals).values(record);

  await emitClinicalEvent({
    type: "vital.created",
    resourceId: id,
    patientId: input.patient_id,
    timestamp: now,
    payload: { vitalType: input.type, value: input.value_primary },
  });

  return {
    id,
    patient_id: input.patient_id,
    recorded_at: input.recorded_at,
    type: input.type,
    value_primary: input.value_primary,
    value_secondary: input.value_secondary,
    unit: input.unit,
    notes: input.notes,
    provider_id: input.provider_id,
    encounter_id: input.encounter_id,
    created_at: now,
  };
}

/**
 * Retrieves vitals for a patient, optionally filtered by vital type,
 * ordered by recorded_at descending.
 */
export async function getVitalsByPatient(
  patientId: string,
  type?: VitalType,
): Promise<Vital[]> {
  const db = getDb();

  const condition = type
    ? and(eq(vitals.patient_id, patientId), eq(vitals.type, type))
    : eq(vitals.patient_id, patientId);

  const rows = await db
    .select()
    .from(vitals)
    .where(condition)
    .orderBy(desc(vitals.recorded_at));

  return rows.map((row) => ({
    id: row.id,
    patient_id: row.patient_id,
    recorded_at: row.recorded_at,
    type: row.type as VitalType,
    value_primary: row.value_primary,
    value_secondary: row.value_secondary ?? undefined,
    unit: row.unit,
    notes: row.notes ?? undefined,
    provider_id: row.provider_id ?? undefined,
    encounter_id: row.encounter_id ?? undefined,
    source_system: row.source_system ?? undefined,
    created_at: row.created_at,
  }));
}

/**
 * Retrieves the most recent vital of each type for a patient.
 */
export async function getLatestVitals(
  patientId: string,
): Promise<Vital[]> {
  // Fetch all vitals for the patient, then deduplicate by type keeping the latest
  const all = await getVitalsByPatient(patientId);

  const latestByType = new Map<string, Vital>();
  for (const vital of all) {
    if (!latestByType.has(vital.type)) {
      latestByType.set(vital.type, vital);
    }
  }

  return Array.from(latestByType.values());
}
