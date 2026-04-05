import { eq, and, desc } from "drizzle-orm";
import { getDb, labPanels, labResults } from "@carebridge/db-schema";
import type { CreateLabPanelInput } from "@carebridge/validators";
import type { LabPanel, LabResult } from "@carebridge/shared-types";
import { emitClinicalEvent } from "../events.js";

/**
 * Creates a lab panel with its results in a single transaction,
 * then emits a "lab.resulted" event.
 */
export async function createLabPanel(
  input: CreateLabPanelInput,
): Promise<{ panel: LabPanel; results: LabResult[] }> {
  const db = getDb();
  const now = new Date().toISOString();
  const panelId = crypto.randomUUID();

  const panelRecord: typeof labPanels.$inferInsert = {
    id: panelId,
    patient_id: input.patient_id,
    panel_name: input.panel_name,
    ordered_by: input.ordered_by ?? null,
    collected_at: input.collected_at ?? null,
    reported_at: input.reported_at ?? null,
    notes: input.notes ?? null,
    ordering_provider_id: input.ordering_provider_id ?? null,
    encounter_id: input.encounter_id ?? null,
    created_at: now,
  };

  const resultRecords = input.results.map((r) => ({
    id: crypto.randomUUID(),
    panel_id: panelId,
    test_name: r.test_name,
    test_code: r.test_code ?? null,
    value: r.value,
    unit: r.unit,
    reference_low: r.reference_low ?? null,
    reference_high: r.reference_high ?? null,
    flag: r.flag ?? null,
    notes: r.notes ?? null,
    created_at: now,
  }));

  // Insert panel and results in a transaction
  await db.transaction(async (tx) => {
    await tx.insert(labPanels).values(panelRecord);
    if (resultRecords.length > 0) {
      await tx.insert(labResults).values(resultRecords);
    }
  });

  await emitClinicalEvent({
    type: "lab.resulted",
    resourceId: panelId,
    patient_id: input.patient_id,
    provider_id: input.ordering_provider_id,
    timestamp: now,
    data: { panelName: input.panel_name, resultCount: input.results.length },
  });

  const panel: LabPanel = {
    id: panelId,
    patient_id: input.patient_id,
    panel_name: input.panel_name,
    ordered_by: input.ordered_by,
    collected_at: input.collected_at,
    reported_at: input.reported_at,
    notes: input.notes,
    ordering_provider_id: input.ordering_provider_id,
    encounter_id: input.encounter_id,
    created_at: now,
  };

  const results: LabResult[] = resultRecords.map((r) => ({
    id: r.id,
    panel_id: r.panel_id,
    test_name: r.test_name,
    test_code: r.test_code ?? undefined,
    value: r.value,
    unit: r.unit,
    reference_low: r.reference_low ?? undefined,
    reference_high: r.reference_high ?? undefined,
    flag: (r.flag as LabResult["flag"]) ?? undefined,
    notes: r.notes ?? undefined,
    created_at: r.created_at,
  }));

  return { panel, results };
}

/**
 * Retrieves all lab panels for a patient, each with its results,
 * ordered by collected_at descending.
 */
export async function getLabPanelsByPatient(
  patientId: string,
): Promise<Array<{ panel: LabPanel; results: LabResult[] }>> {
  const db = getDb();

  const panels = await db
    .select()
    .from(labPanels)
    .where(eq(labPanels.patient_id, patientId))
    .orderBy(desc(labPanels.collected_at));

  const output: Array<{ panel: LabPanel; results: LabResult[] }> = [];

  for (const p of panels) {
    const results = await db
      .select()
      .from(labResults)
      .where(eq(labResults.panel_id, p.id));

    output.push({
      panel: {
        id: p.id,
        patient_id: p.patient_id,
        panel_name: p.panel_name,
        ordered_by: p.ordered_by ?? undefined,
        collected_at: p.collected_at ?? undefined,
        reported_at: p.reported_at ?? undefined,
        notes: p.notes ?? undefined,
        ordering_provider_id: p.ordering_provider_id ?? undefined,
        encounter_id: p.encounter_id ?? undefined,
        source_system: p.source_system ?? undefined,
        created_at: p.created_at,
      },
      results: results.map((r) => ({
        id: r.id,
        panel_id: r.panel_id,
        test_name: r.test_name,
        test_code: r.test_code ?? undefined,
        value: r.value,
        unit: r.unit,
        reference_low: r.reference_low ?? undefined,
        reference_high: r.reference_high ?? undefined,
        flag: (r.flag as LabResult["flag"]) ?? undefined,
        notes: r.notes ?? undefined,
        created_at: r.created_at,
      })),
    });
  }

  return output;
}

/**
 * Retrieves the history of a specific lab test for a patient,
 * ordered by date descending, useful for trending values.
 */
export async function getLabResultHistory(
  patientId: string,
  testName: string,
): Promise<LabResult[]> {
  const db = getDb();

  // Get all panel IDs for this patient
  const patientPanels = await db
    .select({ id: labPanels.id })
    .from(labPanels)
    .where(eq(labPanels.patient_id, patientId));

  const panelIds = patientPanels.map((p) => p.id);
  if (panelIds.length === 0) return [];

  // Fetch results matching the test name across all patient panels
  const allResults: LabResult[] = [];
  for (const panelId of panelIds) {
    const results = await db
      .select()
      .from(labResults)
      .where(and(eq(labResults.panel_id, panelId), eq(labResults.test_name, testName)))
      .orderBy(desc(labResults.created_at));

    for (const r of results) {
      allResults.push({
        id: r.id,
        panel_id: r.panel_id,
        test_name: r.test_name,
        test_code: r.test_code ?? undefined,
        value: r.value,
        unit: r.unit,
        reference_low: r.reference_low ?? undefined,
        reference_high: r.reference_high ?? undefined,
        flag: (r.flag as LabResult["flag"]) ?? undefined,
        notes: r.notes ?? undefined,
        created_at: r.created_at,
      });
    }
  }

  // Sort by created_at descending
  allResults.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return allResults;
}
