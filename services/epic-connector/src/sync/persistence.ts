/**
 * Persistence layer for Epic-synced FHIR resources (#391).
 *
 * Each persistResource* function:
 *  1. Looks up the existing CareBridge row for the (Epic resource_type, resource_id)
 *     tuple via the `fhir_resources` mapping table.
 *  2. UPSERTs the target row (insert when no mapping exists; update when
 *     it does).
 *  3. UPSERTs the `fhir_resources` mapping row so the next sync pull can
 *     find the same internal row.
 *  4. Records a conflict to `audit_log` if the existing target row has
 *     `source_system != "epic"` — Epic does not get to overwrite
 *     CareBridge-originated data; we keep CareBridge's row and log the
 *     attempted overwrite for manual review.
 *
 * Idempotent by design: re-running the same FHIR resource is a no-op
 * after the first call other than refreshing `updated_at`. This lets
 * the BullMQ job runner retry freely on transient errors.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  patients,
  medications,
  vitals,
  labPanels,
  labResults,
  diagnoses,
  allergies,
  encounters,
  fhirResources,
  auditLog,
} from "@carebridge/db-schema";
import {
  epicPatientToRow,
  epicMedicationRequestToRow,
  epicMedicationStatementToRow,
  epicObservationToRow,
  epicConditionToRow,
  epicAllergyToRow,
  epicEncounterToRow,
  EPIC_SOURCE_SYSTEM_TAG,
} from "../converters.js";
import type { FhirResource } from "../fhir-types.js";

const EPIC_SYNC_AUDIT_USER = "system:epic-sync";

export interface PersistResult {
  /** Internal CareBridge row id, or null when the resource was unmappable. */
  internalId: string | null;
  /** Discriminator for downstream event emission. */
  kind:
    | "patient"
    | "medication"
    | "vital"
    | "lab"
    | "diagnosis"
    | "allergy"
    | "encounter"
    | "unmapped";
  /** True when the call inserted a new row; false when it updated. */
  inserted: boolean;
  /** Set when the call rejected an Epic update due to source_system mismatch. */
  conflict?: string;
}

interface MappingLookup {
  internalId: string | null;
  /** When set, an existing target row owns this resource with non-Epic source. */
  existingSourceSystem?: string | null;
}

async function findMapping(
  resourceType: string,
  fhirId: string,
): Promise<MappingLookup> {
  const db = getDb();
  const rows = await db
    .select()
    .from(fhirResources)
    .where(
      and(
        eq(fhirResources.resource_type, resourceType),
        eq(fhirResources.resource_id, fhirId),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return { internalId: null };
  return {
    internalId: existing.internal_record_id ?? null,
    existingSourceSystem: existing.source_system,
  };
}

async function upsertMapping(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  resource: unknown;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  // fhir_resources.id is a free-form PK in the existing schema; we
  // synthesise a deterministic id from (resource_type, fhir_id) so a
  // re-emit upserts the same mapping row rather than appending.
  const mappingId = `epic:${args.resourceType}:${args.fhirId}`;
  await db
    .insert(fhirResources)
    .values({
      id: mappingId,
      resource_type: args.resourceType,
      resource_id: args.fhirId,
      patient_id: args.patientId,
      resource: args.resource as object,
      source_system: EPIC_SOURCE_SYSTEM_TAG,
      internal_record_id: args.internalId,
      imported_at: now,
    })
    .onConflictDoUpdate({
      target: fhirResources.id,
      set: {
        resource: args.resource as object,
        internal_record_id: args.internalId,
        imported_at: now,
      },
    });
}

async function logSourceConflict(args: {
  resourceType: string;
  fhirId: string;
  internalId: string;
  patientId: string | null;
  existingSourceSystem: string | null | undefined;
}): Promise<void> {
  const db = getDb();
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: EPIC_SYNC_AUDIT_USER,
    action: "update",
    resource_type: args.resourceType,
    resource_id: args.internalId,
    patient_id: args.patientId,
    success: false,
    details: JSON.stringify({
      reason: "source_system_conflict",
      attempted_source: EPIC_SOURCE_SYSTEM_TAG,
      existing_source: args.existingSourceSystem ?? null,
      epic_fhir_id: args.fhirId,
      resolution: "keep_carebridge_value",
    }),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Per-row write helpers: each calls findMapping → INSERT or UPDATE on
 * the target table → upsertMapping. The conflict check (source_system
 * != "epic") refuses to overwrite CareBridge-originated rows.
 */

export async function persistPatient(
  resource: FhirResource,
): Promise<PersistResult> {
  const row = epicPatientToRow(resource);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const mapping = await findMapping("Patient", fhirId);
  const db = getDb();
  const now = new Date().toISOString();

  if (mapping.internalId) {
    // Patient already imported — update only Epic-owned rows.
    // Patient identity is treated as Epic-owned when first imported
    // from Epic, so the conflict check is a belt-and-braces guard.
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Patient",
        fhirId,
        internalId: mapping.internalId,
        patientId: mapping.internalId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "patient",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(patients)
      .set({
        name: row.name,
        date_of_birth: row.date_of_birth,
        biological_sex: row.biological_sex,
        mrn: row.mrn ?? undefined,
        updated_at: now,
      })
      .where(eq(patients.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Patient",
      fhirId,
      internalId: mapping.internalId,
      patientId: mapping.internalId,
      resource,
    });
    return { internalId: mapping.internalId, kind: "patient", inserted: false };
  }

  const id = crypto.randomUUID();
  await db.insert(patients).values({
    id,
    mrn: row.mrn ?? undefined,
    name: row.name,
    date_of_birth: row.date_of_birth,
    biological_sex: row.biological_sex,
    created_at: now,
    updated_at: now,
  });
  await upsertMapping({
    resourceType: "Patient",
    fhirId,
    internalId: id,
    patientId: id,
    resource,
  });
  return { internalId: id, kind: "patient", inserted: true };
}

export async function persistMedicationRequest(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const row = epicMedicationRequestToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };
  return persistMedicationRow(row, resource, patientId, "MedicationRequest");
}

export async function persistMedicationStatement(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const row = epicMedicationStatementToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };
  return persistMedicationRow(row, resource, patientId, "MedicationStatement");
}

async function persistMedicationRow(
  row: NonNullable<ReturnType<typeof epicMedicationRequestToRow>>,
  resource: FhirResource,
  patientId: string,
  resourceType: "MedicationRequest" | "MedicationStatement",
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const mapping = await findMapping(resourceType, fhirId);
  const db = getDb();
  const now = new Date().toISOString();

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType,
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "medication",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(medications)
      .set({
        name: row.name,
        dose_amount: row.dose_amount,
        dose_unit: row.dose_unit,
        route: row.route,
        frequency: row.frequency,
        status: row.status,
        rxnorm_code: row.rxnorm_code,
        max_doses_per_day: row.max_doses_per_day,
        updated_at: now,
      })
      .where(eq(medications.id, mapping.internalId));
    await upsertMapping({
      resourceType,
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "medication",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(medications).values({
    id,
    patient_id: patientId,
    name: row.name,
    dose_amount: row.dose_amount,
    dose_unit: row.dose_unit,
    route: row.route,
    frequency: row.frequency,
    status: row.status,
    rxnorm_code: row.rxnorm_code,
    max_doses_per_day: row.max_doses_per_day,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
    updated_at: now,
  });
  await upsertMapping({
    resourceType,
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  return { internalId: id, kind: "medication", inserted: true };
}

export async function persistObservation(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const conversion = epicObservationToRow(resource, patientId);
  if (conversion.kind === "unmapped") {
    return { internalId: null, kind: "unmapped", inserted: false };
  }

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Observation", fhirId);

  if (conversion.kind === "vital") {
    if (mapping.internalId) {
      if (
        mapping.existingSourceSystem &&
        mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
      ) {
        await logSourceConflict({
          resourceType: "Observation",
          fhirId,
          internalId: mapping.internalId,
          patientId,
          existingSourceSystem: mapping.existingSourceSystem,
        });
        return {
          internalId: mapping.internalId,
          kind: "vital",
          inserted: false,
          conflict: "source_system_conflict",
        };
      }
      await db
        .update(vitals)
        .set({
          type: conversion.row.type,
          loinc_code: conversion.row.loinc_code,
          value_primary: conversion.row.value_primary,
          value_secondary: conversion.row.value_secondary,
          unit: conversion.row.unit,
          recorded_at: conversion.row.recorded_at,
        })
        .where(eq(vitals.id, mapping.internalId));
      await upsertMapping({
        resourceType: "Observation",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        resource,
      });
      return {
        internalId: mapping.internalId,
        kind: "vital",
        inserted: false,
      };
    }
    const id = crypto.randomUUID();
    await db.insert(vitals).values({
      id,
      patient_id: patientId,
      type: conversion.row.type,
      loinc_code: conversion.row.loinc_code,
      value_primary: conversion.row.value_primary,
      value_secondary: conversion.row.value_secondary,
      unit: conversion.row.unit,
      recorded_at: conversion.row.recorded_at,
      source_system: EPIC_SOURCE_SYSTEM_TAG,
      created_at: now,
    });
    await upsertMapping({
      resourceType: "Observation",
      fhirId,
      internalId: id,
      patientId,
      resource,
    });
    return { internalId: id, kind: "vital", inserted: true };
  }

  // Lab result — single-result panel synthesised for the Epic
  // resource. Multi-test panels arriving from Epic come in as a
  // DiagnosticReport (deferred to #391-followup) and are not handled
  // here yet.
  if (mapping.internalId) {
    // Existing lab_results rows are leaves — conflict logic on the panel
    // level is out of scope for the first cut. Refresh the value in place.
    await db
      .update(labResults)
      .set({
        test_name: conversion.row.test_name,
        test_code: conversion.row.test_code,
        value: conversion.row.value,
        unit: conversion.row.unit,
        reference_low: conversion.row.reference_low,
        reference_high: conversion.row.reference_high,
        flag: conversion.row.flag,
      })
      .where(eq(labResults.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Observation",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return { internalId: mapping.internalId, kind: "lab", inserted: false };
  }

  const panelId = crypto.randomUUID();
  await db.insert(labPanels).values({
    id: panelId,
    patient_id: patientId,
    panel_name: conversion.row.test_name,
    collected_at: conversion.row.recorded_at,
    reported_at: conversion.row.recorded_at,
    source_system: EPIC_SOURCE_SYSTEM_TAG,
    created_at: now,
  });
  const resultId = crypto.randomUUID();
  await db.insert(labResults).values({
    id: resultId,
    panel_id: panelId,
    test_name: conversion.row.test_name,
    test_code: conversion.row.test_code,
    value: conversion.row.value,
    unit: conversion.row.unit,
    reference_low: conversion.row.reference_low,
    reference_high: conversion.row.reference_high,
    flag: conversion.row.flag,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Observation",
    fhirId,
    internalId: resultId,
    patientId,
    resource,
  });
  return { internalId: resultId, kind: "lab", inserted: true };
}

export async function persistCondition(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicConditionToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Condition", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Condition",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "diagnosis",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(diagnoses)
      .set({
        description: row.description,
        icd10_code: row.icd10_code,
        snomed_code: row.snomed_code,
        status: row.status,
        onset_date: row.onset_date,
        resolved_date: row.resolved_date,
      })
      .where(eq(diagnoses.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Condition",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "diagnosis",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(diagnoses).values({
    id,
    patient_id: patientId,
    description: row.description,
    icd10_code: row.icd10_code,
    snomed_code: row.snomed_code,
    status: row.status,
    onset_date: row.onset_date,
    resolved_date: row.resolved_date,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Condition",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  return { internalId: id, kind: "diagnosis", inserted: true };
}

export async function persistAllergy(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicAllergyToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("AllergyIntolerance", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "AllergyIntolerance",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "allergy",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(allergies)
      .set({
        allergen: row.allergen,
        severity: row.severity,
        reaction: row.reaction,
      })
      .where(eq(allergies.id, mapping.internalId));
    await upsertMapping({
      resourceType: "AllergyIntolerance",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "allergy",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(allergies).values({
    id,
    patient_id: patientId,
    allergen: row.allergen,
    severity: row.severity,
    reaction: row.reaction,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "AllergyIntolerance",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  return { internalId: id, kind: "allergy", inserted: true };
}

/**
 * Persist an Epic FHIR Encounter to the `encounters` table (#1181).
 *
 * Closes the last gap of #390 — the FHIR client has searchEncounters and
 * #1181 adds the converter + this writer + sync-worker fan-out. The
 * `encounters` table doesn't carry a dedicated `epic_encounter_id` or
 * `source_system` column today; the FHIR resource.id round-trips through
 * the `fhir_resources` mapping row, and source provenance is recoverable
 * via the same mapping table. A future migration can lift those fields
 * onto the table without changing this writer.
 */
export async function persistEncounter(
  resource: FhirResource,
  patientId: string,
): Promise<PersistResult> {
  const fhirId = resource.id;
  if (!fhirId) return { internalId: null, kind: "unmapped", inserted: false };

  const row = epicEncounterToRow(resource, patientId);
  if (!row) return { internalId: null, kind: "unmapped", inserted: false };

  const db = getDb();
  const now = new Date().toISOString();
  const mapping = await findMapping("Encounter", fhirId);

  if (mapping.internalId) {
    if (
      mapping.existingSourceSystem &&
      mapping.existingSourceSystem !== EPIC_SOURCE_SYSTEM_TAG
    ) {
      await logSourceConflict({
        resourceType: "Encounter",
        fhirId,
        internalId: mapping.internalId,
        patientId,
        existingSourceSystem: mapping.existingSourceSystem,
      });
      return {
        internalId: mapping.internalId,
        kind: "encounter",
        inserted: false,
        conflict: "source_system_conflict",
      };
    }
    await db
      .update(encounters)
      .set({
        encounter_type: row.encounter_type,
        status: row.status,
        start_time: row.start_time,
        end_time: row.end_time,
        location: row.location,
        reason: row.reason,
      })
      .where(eq(encounters.id, mapping.internalId));
    await upsertMapping({
      resourceType: "Encounter",
      fhirId,
      internalId: mapping.internalId,
      patientId,
      resource,
    });
    return {
      internalId: mapping.internalId,
      kind: "encounter",
      inserted: false,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(encounters).values({
    id,
    patient_id: patientId,
    encounter_type: row.encounter_type,
    status: row.status,
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location,
    reason: row.reason,
    created_at: now,
  });
  await upsertMapping({
    resourceType: "Encounter",
    fhirId,
    internalId: id,
    patientId,
    resource,
  });
  return { internalId: id, kind: "encounter", inserted: true };
}
