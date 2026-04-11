/**
 * Medication reconciliation rules.
 *
 * Compares medication lists across encounters to catch discrepancies:
 * - Medications on prior encounter but missing from current (unintentional discontinuation?)
 * - Dose changes without documentation
 * - New medications without clear encounter linkage
 *
 * Fires on encounter status changes via the clinical-events queue.
 */

import type { FlagSeverity, FlagCategory, ClinicalEvent } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";
import { getDb } from "@carebridge/db-schema";
import { medications, encounters } from "@carebridge/db-schema";
import { eq, and, desc } from "drizzle-orm";

/**
 * Check for medication discrepancies when an encounter transitions to "finished".
 *
 * Compares active medications at the current encounter against the previous
 * encounter to catch unreconciled changes.
 */
export async function checkMedicationReconciliation(
  event: ClinicalEvent,
): Promise<RuleFlag[]> {
  const flags: RuleFlag[] = [];

  // Only run on encounter-related events that indicate a transition
  // The event data should contain encounter_id and new_status
  const encounterId = event.data.encounter_id as string | undefined;
  const newStatus = event.data.new_status as string | undefined;

  if (!encounterId || newStatus !== "finished") return flags;

  const db = getDb();

  // Get the current encounter
  const [currentEncounter] = await db.select().from(encounters)
    .where(eq(encounters.id, encounterId));

  if (!currentEncounter) return flags;

  // Get the previous encounter for this patient (most recent before current)
  const previousEncounters = await db.select().from(encounters)
    .where(
      and(
        eq(encounters.patient_id, event.patient_id),
        eq(encounters.status, "finished"),
      ),
    )
    .orderBy(desc(encounters.start_time))
    .limit(2); // Current + previous

  // Filter to get the one before current
  const previousEncounter = previousEncounters.find((e) => e.id !== encounterId);

  if (!previousEncounter) return flags; // No prior encounter to compare against

  // Get active medications linked to each encounter
  const currentMeds = await db.select().from(medications)
    .where(
      and(
        eq(medications.patient_id, event.patient_id),
        eq(medications.status, "active"),
      ),
    );

  // Get medications that were active during the previous encounter
  // (medications with encounter_id matching previous, or started before and still active)
  const previousMeds = await db.select().from(medications)
    .where(
      and(
        eq(medications.patient_id, event.patient_id),
        eq(medications.encounter_id, previousEncounter.id),
      ),
    );

  // Check for medications that were in the previous encounter but are now missing
  const currentMedNames = new Set(currentMeds.map((m) => m.name.toLowerCase()));

  for (const prevMed of previousMeds) {
    if (prevMed.status === "discontinued") continue; // Intentionally stopped

    if (!currentMedNames.has(prevMed.name.toLowerCase())) {
      flags.push({
        severity: "warning" as FlagSeverity,
        category: "medication-safety" as FlagCategory,
        summary: `Medication "${prevMed.name}" from prior encounter not found in current medication list`,
        rationale:
          `"${prevMed.name}" (${prevMed.dose_amount ?? ""} ${prevMed.dose_unit ?? ""}, ${prevMed.frequency ?? ""}) ` +
          `was active during the previous encounter but does not appear in the current active medication list. ` +
          `This may represent an unintentional discontinuation during care transition.`,
        suggested_action:
          `Verify whether "${prevMed.name}" was intentionally discontinued. If not, reconcile the medication list ` +
          `and document the decision. If discontinued, add a discontinuation note.`,
        notify_specialties: ["pharmacy"],
        rule_id: `MED-RECON-MISSING-${prevMed.id.slice(0, 8).toUpperCase()}`,
      });
    }
  }

  // Check for dose changes between encounters (same med name, different dose)
  for (const currentMed of currentMeds) {
    const matchingPrev = previousMeds.find(
      (pm) => pm.name.toLowerCase() === currentMed.name.toLowerCase() && pm.status !== "discontinued",
    );

    if (matchingPrev && matchingPrev.dose_amount !== currentMed.dose_amount) {
      flags.push({
        severity: "info" as FlagSeverity,
        category: "medication-safety" as FlagCategory,
        summary: `Dose change for "${currentMed.name}": ${matchingPrev.dose_amount} → ${currentMed.dose_amount} ${currentMed.dose_unit ?? ""}`,
        rationale:
          `"${currentMed.name}" dose changed from ${matchingPrev.dose_amount} ${matchingPrev.dose_unit ?? ""} ` +
          `to ${currentMed.dose_amount} ${currentMed.dose_unit ?? ""} between encounters. ` +
          `Dose changes during care transitions should be documented with clinical rationale.`,
        suggested_action:
          `Verify dose change is intentional and documented in clinical notes.`,
        notify_specialties: [],
        rule_id: `MED-RECON-DOSE-${currentMed.id.slice(0, 8).toUpperCase()}`,
      });
    }
  }

  return flags;
}
