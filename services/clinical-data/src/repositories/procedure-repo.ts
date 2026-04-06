import { eq, desc } from "drizzle-orm";
import { getDb, procedures } from "@carebridge/db-schema";
import type { CreateProcedureInput } from "@carebridge/validators";
import type { Procedure, ProcedureStatus } from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Creates a procedure record. If the status is "completed",
 * emits a "procedure.completed" event.
 */
export async function createProcedure(input: CreateProcedureInput): Promise<Procedure> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const record: typeof procedures.$inferInsert = {
    id,
    patient_id: input.patient_id,
    name: input.name,
    cpt_code: input.cpt_code ?? null,
    icd10_codes: input.icd10_codes ?? null,
    status: input.status ?? "scheduled",
    performed_at: input.performed_at ?? null,
    performed_by: input.performed_by ?? null,
    provider_id: input.provider_id ?? null,
    encounter_id: input.encounter_id ?? null,
    notes: input.notes ?? null,
    created_at: now,
  };

  await db.insert(procedures).values(record);

  const effectiveStatus = input.status ?? "scheduled";

  if (effectiveStatus === "completed") {
    await emitClinicalEvent({
      id: crypto.randomUUID(),
      type: "procedure.completed",
      patient_id: input.patient_id,
      timestamp: now,
      data: { resourceId: id, name: input.name, cptCode: input.cpt_code },
    });
  }

  return {
    id,
    patient_id: input.patient_id,
    name: input.name,
    cpt_code: input.cpt_code,
    icd10_codes: input.icd10_codes,
    status: effectiveStatus,
    performed_at: input.performed_at,
    performed_by: input.performed_by,
    provider_id: input.provider_id,
    encounter_id: input.encounter_id,
    notes: input.notes,
    created_at: now,
  };
}

/**
 * Retrieves all procedures for a patient, ordered by date descending.
 */
export async function getProceduresByPatient(patientId: string): Promise<Procedure[]> {
  const db = getDb();

  const rows = await db
    .select()
    .from(procedures)
    .where(eq(procedures.patient_id, patientId))
    .orderBy(desc(procedures.created_at));

  return rows.map((row) => ({
    id: row.id,
    patient_id: row.patient_id,
    name: row.name,
    cpt_code: row.cpt_code ?? undefined,
    icd10_codes: (row.icd10_codes as string[] | null) ?? undefined,
    status: row.status as ProcedureStatus,
    performed_at: row.performed_at ?? undefined,
    performed_by: row.performed_by ?? undefined,
    provider_id: row.provider_id ?? undefined,
    encounter_id: row.encounter_id ?? undefined,
    notes: row.notes ?? undefined,
    source_system: row.source_system ?? undefined,
    created_at: row.created_at,
  }));
}
