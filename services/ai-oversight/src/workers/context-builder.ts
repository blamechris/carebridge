/**
 * Assembles the patient context for LLM review.
 *
 * This is the "gather everything" step: pull the patient's full clinical picture
 * from the database so the LLM can reason over the complete record, not just
 * the triggering event in isolation.
 */

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  patients,
  diagnoses,
  medications,
  vitals,
  labPanels,
  labResults,
  clinicalFlags,
  careTeamMembers,
  allergies,
} from "@carebridge/db-schema";
import { users } from "@carebridge/db-schema";
import type { ReviewContext } from "@carebridge/ai-prompts";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { calculateDelta } from "@carebridge/medical-logic";

/**
 * Build the full patient context needed for LLM clinical review.
 */
export async function buildPatientContext(
  patientId: string,
  triggerEvent: ClinicalEvent,
): Promise<ReviewContext> {
  const db = getDb();

  // Run all queries in parallel for speed
  const [
    patientRow,
    activeDiagnoses,
    patientAllergies,
    activeMeds,
    latestVitals,
    recentPanels,
    recentFlags,
    careTeam,
  ] = await Promise.all([
    db.query.patients.findFirst({
      where: eq(patients.id, patientId),
    }),
    db
      .select()
      .from(diagnoses)
      .where(
        and(eq(diagnoses.patient_id, patientId), eq(diagnoses.status, "active")),
      ),
    db
      .select()
      .from(allergies)
      .where(eq(allergies.patient_id, patientId)),
    db
      .select()
      .from(medications)
      .where(
        and(
          eq(medications.patient_id, patientId),
          eq(medications.status, "active"),
        ),
      ),
    db
      .select()
      .from(vitals)
      .where(eq(vitals.patient_id, patientId))
      .orderBy(desc(vitals.recorded_at))
      .limit(20),
    db
      .select()
      .from(labPanels)
      .where(eq(labPanels.patient_id, patientId))
      .orderBy(desc(labPanels.collected_at))
      .limit(5),
    db
      .select()
      .from(clinicalFlags)
      .where(eq(clinicalFlags.patient_id, patientId))
      .orderBy(desc(clinicalFlags.created_at))
      .limit(10),
    db
      .select()
      .from(careTeamMembers)
      .where(
        and(
          eq(careTeamMembers.patient_id, patientId),
          eq(careTeamMembers.is_active, true),
        ),
      ),
  ]);

  // Calculate patient age
  let age = 0;
  if (patientRow?.date_of_birth) {
    const dob = new Date(patientRow.date_of_birth);
    const now = new Date();
    age = Math.floor(
      (now.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
    );
  }

  // Build latest vitals map (most recent per type)
  const latestVitalsByType: ReviewContext["latest_vitals"] = {};
  const vitalsByType = new Map<string, typeof latestVitals>();
  for (const v of latestVitals) {
    const existing = vitalsByType.get(v.type);
    if (!existing) {
      vitalsByType.set(v.type, [v]);
    } else {
      existing.push(v);
    }
  }
  for (const [type, records] of vitalsByType) {
    const latest = records[0];
    const values = records.map((r) => r.value_primary).reverse();
    const delta = calculateDelta(values);
    let trend: "rising" | "falling" | "stable" | undefined;
    if (delta) {
      if (Math.abs(delta.pctChange) < 2) trend = "stable";
      else if (delta.change > 0) trend = "rising";
      else trend = "falling";
    }
    latestVitalsByType[type] = {
      value: latest.value_primary,
      unit: latest.unit,
      recorded_at: latest.recorded_at,
      trend,
    };
  }

  // Fetch lab results for recent panels
  let recentLabResults: ReviewContext["recent_labs"] = [];
  if (recentPanels.length > 0) {
    const panelIds = recentPanels.map((p) => p.id);
    const allResults: typeof labResults.$inferSelect[] = [];
    for (const panelId of panelIds) {
      const results = await db
        .select()
        .from(labResults)
        .where(eq(labResults.panel_id, panelId));
      allResults.push(...results);
    }

    recentLabResults = allResults.map((r) => ({
      test_name: r.test_name,
      value: r.value,
      unit: r.unit,
      flag: r.flag ?? null,
      collected_at: r.created_at,
    }));
  }

  // Resolve care team member names
  const careTeamWithNames: ReviewContext["care_team"] = [];
  for (const member of careTeam) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, member.provider_id),
    });
    careTeamWithNames.push({
      name: user?.name ?? "Unknown Provider",
      specialty: member.specialty ?? member.role,
    });
  }

  // Build trigger event summary
  const triggerSummary = buildEventSummary(triggerEvent);

  return {
    patient: {
      age,
      sex: patientRow?.biological_sex ?? "unknown",
      active_diagnoses: activeDiagnoses.map((d) => d.description),
      allergies: patientAllergies.map((a) => a.allergen),
    },
    active_medications: activeMeds.map((m) => ({
      name: m.name,
      dose: `${m.dose_amount ?? ""} ${m.dose_unit ?? ""}`.trim() || "unknown",
      route: m.route ?? "unknown",
      frequency: m.frequency ?? "unknown",
      started_at: m.started_at ?? m.created_at,
    })),
    latest_vitals: latestVitalsByType,
    recent_labs: recentLabResults.length > 0 ? recentLabResults : undefined,
    triggering_event: {
      type: triggerEvent.type,
      summary: triggerSummary,
      detail: JSON.stringify(triggerEvent.data, null, 2),
    },
    recent_flags: recentFlags.map((f) => ({
      severity: f.severity,
      summary: f.summary,
      status: f.status,
      created_at: f.created_at,
    })),
    care_team: careTeamWithNames,
  };
}

function buildEventSummary(event: ClinicalEvent): string {
  switch (event.type) {
    case "vital.created":
    case "vital.updated":
      return `New vital recorded: ${event.data.type} = ${event.data.value_primary} ${event.data.unit ?? ""}`.trim();
    case "lab.resulted":
      return `Lab panel resulted: ${event.data.panel_name ?? "panel"}`;
    case "medication.created":
    case "medication.updated":
      return `Medication ${event.type === "medication.created" ? "prescribed" : "updated"}: ${event.data.name ?? "unknown"}`;
    case "note.saved":
    case "note.signed":
      return `Clinical note ${event.type === "note.signed" ? "signed" : "saved"}`;
    case "diagnosis.added":
      return `New diagnosis added: ${event.data.description ?? "unknown"}`;
    case "procedure.completed":
      return `Procedure completed: ${event.data.name ?? "unknown"}`;
    case "fhir.imported":
      return `FHIR data imported`;
    default:
      return `Clinical event: ${event.type}`;
  }
}
