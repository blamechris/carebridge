import { eq, and, desc } from "drizzle-orm";
import { getDb, medications, medLogs, allergies } from "@carebridge/db-schema";
import type { CreateMedicationInput, UpdateMedicationInput } from "@carebridge/shared-types";
import type { Medication, MedLog, MedStatus } from "@carebridge/shared-types";
import {
  CROSS_REACTIVITY_MAP,
  expandAllergenAliases,
  parseFrequencyText,
  serializeFrequency,
} from "@carebridge/medical-logic";
import { emitClinicalEvent } from "../events.js";

export interface AllergyConflict {
  allergen: string;
  severity: string | null;
  reaction: string | null;
  matchType: "direct" | "cross-reactivity";
  drugClass?: string;
}

/**
 * Check a medication name against a patient's allergy list.
 * Returns any conflicts found via direct name match or cross-reactivity class.
 */
export async function checkAllergyConflicts(
  patientId: string,
  medicationName: string,
): Promise<AllergyConflict[]> {
  const db = getDb();
  const patientAllergies = await db
    .select()
    .from(allergies)
    .where(eq(allergies.patient_id, patientId));

  if (patientAllergies.length === 0) return [];

  const conflicts: AllergyConflict[] = [];
  const medLower = medicationName.toLowerCase();
  const firstMedToken = medLower.split(" ")[0] ?? "";

  for (const allergy of patientAllergies) {
    // Expand shorthand / brand-name allergens to their canonical generic /
    // class via the shared synonym table (#232). Without this the writer
    // missed cases the post-write AI rule caught — e.g. allergy "Red Man
    // Syndrome" + medication "vancomycin 1g IV" matched no entry on the
    // direct path because the strings don't overlap textually, even
    // though Red Man IS the vancomycin infusion reaction.
    const allergenAliases = expandAllergenAliases(allergy.allergen);
    const allergenBlob = allergenAliases.join(" ");

    // Strategy 1: Direct name match against any alias of the allergen.
    const directMatch = allergenAliases.some((alias) => {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.length <= 4) {
        // Short aliases (PCN, ASA, amox, ampi, apap, lmwh, acei) need
        // a word boundary so they don't substring-hit unrelated drugs
        // ("pcn" → "pentoxifylline", "amox" → "amoxapine",
        // "ampi" → "ampyra"). The boundary cutoff matches the AI rule
        // (#994) so writer and rule agree on false-positive avoidance.
        const boundary = new RegExp(
          `\\b${aliasLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        );
        return boundary.test(medLower);
      }
      if (medLower.includes(aliasLower)) return true;
      // Catch the case where the medication's first token is a stem of
      // the alias (e.g. med "amoxicillin" first token "amoxicillin" sits
      // inside alias-blob "penicillin amoxicillin ampicillin").
      return firstMedToken.length > 3 && aliasLower.includes(firstMedToken);
    });
    if (directMatch) {
      conflicts.push({
        allergen: allergy.allergen,
        severity: allergy.severity,
        reaction: allergy.reaction,
        matchType: "direct",
      });
      continue; // Don't double-match via cross-reactivity
    }

    // Strategy 2: Cross-reactivity class matching. Run the allergen
    // pattern against the alias blob so e.g. an allergy charted as "PCN"
    // still reaches the penicillin cross-reactivity rule.
    for (const mapping of CROSS_REACTIVITY_MAP) {
      if (
        mapping.allergenPattern.test(allergenBlob) &&
        mapping.medicationPattern.test(medicationName)
      ) {
        conflicts.push({
          allergen: allergy.allergen,
          severity: allergy.severity,
          reaction: allergy.reaction,
          matchType: "cross-reactivity",
          drugClass: mapping.class,
        });
        break; // One cross-reactivity match per allergy is enough
      }
    }
  }

  return conflicts;
}

/**
 * Thrown when an optimistic locking conflict is detected (concurrent modification).
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Creates a new medication record and emits a "medication.created" event.
 */
export async function createMedication(input: CreateMedicationInput): Promise<Medication> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // Synchronous allergy safety check — blocks prescription of allergenic drugs
  const allergyConflicts = await checkAllergyConflicts(input.patient_id, input.name);
  if (allergyConflicts.length > 0) {
    const details = allergyConflicts.map((c) => {
      const base = `allergy to "${c.allergen}" (severity: ${c.severity ?? "unknown"}, reaction: ${c.reaction ?? "not specified"})`;
      return c.matchType === "cross-reactivity"
        ? `${base} — cross-reactivity via ${c.drugClass} class`
        : base;
    });
    throw new Error(
      `ALLERGY_CONFLICT: Medication "${input.name}" conflicts with patient allergies: ${details.join("; ")}`,
    );
  }

  const record: typeof medications.$inferInsert = {
    id,
    patient_id: input.patient_id,
    name: input.name,
    brand_name: input.brand_name ?? null,
    dose_amount: input.dose_amount ?? null,
    dose_unit: input.dose_unit ?? null,
    route: input.route ?? null,
    frequency: input.frequency ?? null,
    // Pre-parse to the structured column at write time (#931). When the
    // free-text frequency can't be classified, store null and let the
    // rule fall back to runtime parsing — same fail-open behaviour as
    // before the structured column existed.
    frequency_structured: serializeFrequency(parseFrequencyText(input.frequency ?? null)),
    max_doses_per_day: input.max_doses_per_day ?? null,
    status: input.status ?? "active",
    started_at: input.started_at ?? null,
    ended_at: input.ended_at ?? null,
    prescribed_by: input.prescribed_by ?? null,
    notes: input.notes ?? null,
    rxnorm_code: input.rxnorm_code ?? null,
    ordering_provider_id: input.ordering_provider_id ?? null,
    encounter_id: input.encounter_id ?? null,
    chronic: input.chronic ?? null,
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
    frequency_structured:
      serializeFrequency(parseFrequencyText(input.frequency ?? null)) ?? undefined,
    max_doses_per_day: input.max_doses_per_day,
    status: input.status ?? "active",
    started_at: input.started_at,
    ended_at: input.ended_at,
    prescribed_by: input.prescribed_by,
    notes: input.notes,
    rxnorm_code: input.rxnorm_code,
    ordering_provider_id: input.ordering_provider_id,
    encounter_id: input.encounter_id,
    chronic: input.chronic,
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

  const { expectedUpdatedAt, ...fields } = input;

  const updates: Record<string, unknown> = { updated_at: now };
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.brand_name !== undefined) updates.brand_name = fields.brand_name;
  if (fields.dose_amount !== undefined) updates.dose_amount = fields.dose_amount;
  if (fields.dose_unit !== undefined) updates.dose_unit = fields.dose_unit;
  if (fields.route !== undefined) updates.route = fields.route;
  if (fields.frequency !== undefined) {
    updates.frequency = fields.frequency;
    // Re-derive the structured column whenever the free-text changes (#931).
    updates.frequency_structured = serializeFrequency(parseFrequencyText(fields.frequency));
  }
  if (fields.max_doses_per_day !== undefined) updates.max_doses_per_day = fields.max_doses_per_day;
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.started_at !== undefined) updates.started_at = fields.started_at;
  if (fields.ended_at !== undefined) updates.ended_at = fields.ended_at;
  if (fields.prescribed_by !== undefined) updates.prescribed_by = fields.prescribed_by;
  if (fields.notes !== undefined) updates.notes = fields.notes;
  if (fields.rxnorm_code !== undefined) updates.rxnorm_code = fields.rxnorm_code;
  if (fields.ordering_provider_id !== undefined) updates.ordering_provider_id = fields.ordering_provider_id;
  if (fields.encounter_id !== undefined) updates.encounter_id = fields.encounter_id;
  if (fields.chronic !== undefined) updates.chronic = fields.chronic;

  // Optimistic locking: when expectedUpdatedAt is provided, only update if the
  // row hasn't been modified since the caller last read it.
  const whereClause = expectedUpdatedAt
    ? and(eq(medications.id, id), eq(medications.updated_at, expectedUpdatedAt))
    : eq(medications.id, id);

  const result = await db.update(medications).set(updates).where(whereClause).returning({ id: medications.id });

  if (result.length === 0 && expectedUpdatedAt) {
    throw new ConflictError("Medication was modified by another user. Please refresh and try again.");
  }

  await emitClinicalEvent({
    id: crypto.randomUUID(),
    type: "medication.updated",
    patient_id: existing.patient_id,
    timestamp: now,
    data: {
      resourceId: id,
      changedFields: Object.keys(fields),
      name: (fields.name ?? existing.name) as string,
      status: (fields.status ?? existing.status) as string,
    },
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
    frequency_structured: updated.frequency_structured ?? undefined,
    max_doses_per_day: updated.max_doses_per_day ?? undefined,
    status: updated.status as MedStatus,
    started_at: updated.started_at ?? undefined,
    ended_at: updated.ended_at ?? undefined,
    prescribed_by: updated.prescribed_by ?? undefined,
    notes: updated.notes ?? undefined,
    rxnorm_code: updated.rxnorm_code ?? undefined,
    ordering_provider_id: updated.ordering_provider_id ?? undefined,
    encounter_id: updated.encounter_id ?? undefined,
    source_system: updated.source_system ?? undefined,
    chronic: updated.chronic ?? undefined,
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
    frequency_structured: row.frequency_structured ?? undefined,
    max_doses_per_day: row.max_doses_per_day ?? undefined,
    status: row.status as MedStatus,
    started_at: row.started_at ?? undefined,
    ended_at: row.ended_at ?? undefined,
    prescribed_by: row.prescribed_by ?? undefined,
    notes: row.notes ?? undefined,
    rxnorm_code: row.rxnorm_code ?? undefined,
    ordering_provider_id: row.ordering_provider_id ?? undefined,
    encounter_id: row.encounter_id ?? undefined,
    source_system: row.source_system ?? undefined,
    chronic: row.chronic ?? undefined,
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
