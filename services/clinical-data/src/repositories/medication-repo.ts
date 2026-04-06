import { eq, and, desc } from "drizzle-orm";
import { getDb, medications, medLogs } from "@carebridge/db-schema";
import type { CreateMedicationInput, UpdateMedicationInput } from "@carebridge/validators";
import type { Medication, MedLog, MedStatus } from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Creates a new medication record and emits a "medication.created" event.
 */
export async function createMedication(input: CreateMedicationInput): Promise<Medication> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const record: typeof medications.$inferInsert = {
    id,
    patient_id: input.patient_id,
    name: input.name,
    brand_name: input.brand_name ?? null,
    dose_amount: input.dose_amount ?? null,
    dose_unit: input.dose_unit ?? null,
    route: input.route ?? null,
    frequency: input.frequency ?? null,
    status: input.status ?? "active",
    started_at: input.started_at ?? null,
    ended_at: input.ended_at ?? null,
    prescribed_by: input.prescribed_by ?? null,
    notes: input.notes ?? null,
    rxnorm_code: input.rxnorm_code ?? null,
    ordering_provider_id: input.ordering_provider_id ?? null,
    encounter_id: input.encounter_id ?? null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(medications).values(record);

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "medication.created",
    patient_id: input.patient_id,
    timestamp: now,
    data: { resourceId: id, name: input.name, status: input.status ?? "active" },
  });

  return {
    id,
    patient_id: input.patient_id,
    name: input.name,
    brand_name: input.brand_name,
    dose_amount: input.dose_amount,
    dose_unit: input.dose_unit,
    route: input.route,
    frequency: input.frequency,
    status: input.status ?? "active",
    started_at: input.started_at,
    ended_at: input.ended_at,
    prescribed_by: input.prescribed_by,
    notes: input.notes,
    rxnorm_code: input.rxnorm_code,
    ordering_provider_id: input.ordering_provider_id,
    encounter_id: input.encounter_id,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Updates an existing medication and emits a "medication.updated" event.
 */
export async function updateMedication(
  id: string,
  input: UpdateMedicationInput,
): Promise<Medication> {
  const db = getDb();
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, id))
    .limit(1);

  if (!existing) {
    throw new Error(`Medication ${id} not found`);
  }

  const updates: Record<string, unknown> = { updated_at: now };
  if (input.name !== undefined) updates.name = input.name;
  if (input.brand_name !== undefined) updates.brand_name = input.brand_name;
  if (input.dose_amount !== undefined) updates.dose_amount = input.dose_amount;
  if (input.dose_unit !== undefined) updates.dose_unit = input.dose_unit;
  if (input.route !== undefined) updates.route = input.route;
  if (input.frequency !== undefined) updates.frequency = input.frequency;
  if (input.status !== undefined) updates.status = input.status;
  if (input.started_at !== undefined) updates.started_at = input.started_at;
  if (input.ended_at !== undefined) updates.ended_at = input.ended_at;
  if (input.prescribed_by !== undefined) updates.prescribed_by = input.prescribed_by;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.rxnorm_code !== undefined) updates.rxnorm_code = input.rxnorm_code;
  if (input.ordering_provider_id !== undefined) updates.ordering_provider_id = input.ordering_provider_id;
  if (input.encounter_id !== undefined) updates.encounter_id = input.encounter_id;

  await db.update(medications).set(updates).where(eq(medications.id, id));

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "medication.updated",
    patient_id: existing.patient_id,
    timestamp: now,
    data: { resourceId: id, changedFields: Object.keys(input) },
  });

  // Re-fetch the updated record
  const [updated] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, id))
    .limit(1);

  return {
    id: updated.id,
    patient_id: updated.patient_id,
    name: updated.name,
    brand_name: updated.brand_name ?? undefined,
    dose_amount: updated.dose_amount ?? undefined,
    dose_unit: updated.dose_unit ?? undefined,
    route: (updated.route as Medication["route"]) ?? undefined,
    frequency: updated.frequency ?? undefined,
    status: updated.status as MedStatus,
    started_at: updated.started_at ?? undefined,
    ended_at: updated.ended_at ?? undefined,
    prescribed_by: updated.prescribed_by ?? undefined,
    notes: updated.notes ?? undefined,
    rxnorm_code: updated.rxnorm_code ?? undefined,
    ordering_provider_id: updated.ordering_provider_id ?? undefined,
    encounter_id: updated.encounter_id ?? undefined,
    source_system: updated.source_system ?? undefined,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  };
}

/**
 * Retrieves medications for a patient, optionally filtered by status.
 */
export async function getMedicationsByPatient(
  patientId: string,
  status?: MedStatus,
): Promise<Medication[]> {
  const db = getDb();

  const condition = status
    ? and(eq(medications.patient_id, patientId), eq(medications.status, status))
    : eq(medications.patient_id, patientId);

  const rows = await db
    .select()
    .from(medications)
    .where(condition)
    .orderBy(desc(medications.created_at));

  return rows.map((row) => ({
    id: row.id,
    patient_id: row.patient_id,
    name: row.name,
    brand_name: row.brand_name ?? undefined,
    dose_amount: row.dose_amount ?? undefined,
    dose_unit: row.dose_unit ?? undefined,
    route: (row.route as Medication["route"]) ?? undefined,
    frequency: row.frequency ?? undefined,
    status: row.status as MedStatus,
    started_at: row.started_at ?? undefined,
    ended_at: row.ended_at ?? undefined,
    prescribed_by: row.prescribed_by ?? undefined,
    notes: row.notes ?? undefined,
    rxnorm_code: row.rxnorm_code ?? undefined,
    ordering_provider_id: row.ordering_provider_id ?? undefined,
    encounter_id: row.encounter_id ?? undefined,
    source_system: row.source_system ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * Logs a medication administration event.
 */
export async function logAdministration(
  medId: string,
  administeredAt: string,
  doseAmount?: number,
  doseUnit?: string,
  administeredBy?: string,
): Promise<MedLog> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // Verify medication exists
  const [med] = await db
    .select()
    .from(medications)
    .where(eq(medications.id, medId))
    .limit(1);

  if (!med) {
    throw new Error(`Medication ${medId} not found`);
  }

  const record: typeof medLogs.$inferInsert = {
    id,
    medication_id: medId,
    administered_at: administeredAt,
    dose_amount: doseAmount ?? null,
    dose_unit: doseUnit ?? null,
    administered_by: administeredBy ?? null,
    created_at: now,
  };

  await db.insert(medLogs).values(record);

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "medication.administered",
    patient_id: med.patient_id,
    timestamp: now,
    data: { resourceId: id, medicationId: medId, administeredAt },
  });

  return {
    id,
    medication_id: medId,
    administered_at: administeredAt,
    dose_amount: doseAmount,
    dose_unit: doseUnit,
    administered_by: administeredBy,
    created_at: now,
  };
}
