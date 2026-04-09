/**
 * Assembles the patient context for LLM review.
 *
 * This is the "gather everything" step: pull the patient's full clinical picture
 * from the database so the LLM can reason over the complete record, not just
 * the triggering event in isolation.
 */

import { eq, and, desc, gte, inArray } from "drizzle-orm";
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
  clinicalNotes,
  encounters,
} from "@carebridge/db-schema";
import { users } from "@carebridge/db-schema";
import type { ReviewContext } from "@carebridge/ai-prompts";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { calculateDelta } from "@carebridge/medical-logic";
import { sanitizeFreeText } from "@carebridge/phi-sanitizer";
import {
  assembleTimeline,
  detectTemporalClusters,
  detectGaps,
  TIMELINE_WINDOW_MS,
} from "./timeline-builder.js";

/**
 * Recursively sanitize all string values in an arbitrary event-data object
 * before it is serialized into an LLM prompt. Prevents semantic prompt
 * injection via patient-controlled free-text fields (note bodies, symptom
 * descriptions, etc.).
 */
function sanitizeEventData(data: unknown): unknown {
  if (typeof data === "string") return sanitizeFreeText(data);
  if (Array.isArray(data)) return data.map(sanitizeEventData);
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([k, v]) => [
        k,
        sanitizeEventData(v),
      ]),
    );
  }
  return data;
}

/**
 * Build the full patient context needed for LLM clinical review.
 */
export async function buildPatientContext(
  patientId: string,
  triggerEvent: ClinicalEvent,
): Promise<ReviewContext> {
  const db = getDb();

  // Phase A3: 30-day temporal window. Anything inside this window also
  // feeds the unified timeline; outside of it we still keep enough
  // recent rows for the legacy "latest snapshot" sections. Using an
  // ISO string lets us reuse the same boundary across every query
  // without worrying about DB server clock skew.
  const windowStartIso = new Date(
    Date.now() - TIMELINE_WINDOW_MS,
  ).toISOString();

  // Run all queries in parallel for speed
  const [
    patientRow,
    activeDiagnoses,
    patientAllergies,
    activeMeds,
    latestVitals,
    windowVitals,
    recentPanels,
    windowNotes,
    windowEncounters,
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
    // Windowed vitals feed the timeline + stale-data gap detection.
    // Bounded by a hard cap so a firehose patient can't blow the
    // prompt budget before token-budget trimming kicks in.
    db
      .select()
      .from(vitals)
      .where(
        and(
          eq(vitals.patient_id, patientId),
          gte(vitals.recorded_at, windowStartIso),
        ),
      )
      .orderBy(desc(vitals.recorded_at))
      .limit(200),
    db
      .select()
      .from(labPanels)
      .where(eq(labPanels.patient_id, patientId))
      .orderBy(desc(labPanels.collected_at))
      .limit(5),
    db
      .select()
      .from(clinicalNotes)
      .where(
        and(
          eq(clinicalNotes.patient_id, patientId),
          gte(clinicalNotes.created_at, windowStartIso),
        ),
      )
      .orderBy(desc(clinicalNotes.created_at))
      .limit(50),
    db
      .select()
      .from(encounters)
      .where(
        and(
          eq(encounters.patient_id, patientId),
          gte(encounters.start_time, windowStartIso),
        ),
      )
      .orderBy(desc(encounters.start_time))
      .limit(50),
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
  // abnormal_count per panel id, used to annotate the timeline entry.
  const abnormalByPanel = new Map<string, number>();
  if (recentPanels.length > 0) {
    const panelIds = recentPanels.map((p) => p.id);
    const allResults = await db
      .select()
      .from(labResults)
      .where(inArray(labResults.panel_id, panelIds));

    for (const r of allResults) {
      if (r.flag && r.flag !== "N") {
        abnormalByPanel.set(
          r.panel_id,
          (abnormalByPanel.get(r.panel_id) ?? 0) + 1,
        );
      }
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
  const memberIds = careTeam.map((m) => m.provider_id);
  const teamUsers =
    memberIds.length > 0
      ? await db
          .select()
          .from(users)
          .where(inArray(users.id, memberIds))
      : [];
  const userMap = new Map(teamUsers.map((u) => [u.id, u]));
  const careTeamWithNames: ReviewContext["care_team"] = careTeam.map(
    (member) => ({
      name: userMap.get(member.provider_id)?.name ?? "Unknown Provider",
      specialty: member.specialty ?? member.role,
    }),
  );

  // Build trigger event summary
  const triggerSummary = buildEventSummary(triggerEvent);

  // Phase A3: assemble the 30-day unified timeline + cluster detection
  // + deterministic gap pre-pass. The timeline inputs are intentionally
  // minimal projections of the drizzle rows — no encrypted free-text
  // fields leak in here, which keeps the prompt PHI surface flat.
  const timeline = assembleTimeline({
    vitals: windowVitals.map((v) => ({
      recorded_at: v.recorded_at,
      type: v.type,
      value_primary: v.value_primary,
      unit: v.unit,
    })),
    lab_panels: recentPanels.map((p) => ({
      collected_at: p.collected_at,
      panel_name: p.panel_name,
      abnormal_count: abnormalByPanel.get(p.id) ?? 0,
    })),
    medications: activeMeds.map((m) => ({
      started_at: m.started_at,
      name: m.name,
      dose_amount: m.dose_amount,
      dose_unit: m.dose_unit,
      status: m.status,
    })),
    notes: windowNotes.map((n) => ({
      created_at: n.created_at,
      signed_at: n.signed_at,
      template_type: n.template_type,
      status: n.status,
    })),
    encounters: windowEncounters.map((e) => ({
      start_time: e.start_time,
      encounter_type: e.encounter_type,
      reason: e.reason,
    })),
  });

  const clusters = detectTemporalClusters(timeline);

  const latestVitalAt = windowVitals[0]?.recorded_at ?? null;
  const latestNoteAt = windowNotes[0]?.created_at ?? null;
  const gaps = detectGaps({
    active_diagnoses_count: activeDiagnoses.length,
    latest_vital_at: latestVitalAt,
    latest_note_at: latestNoteAt,
  });

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
    timeline_30d: timeline,
    temporal_clusters: clusters,
    gaps_detected: gaps,
    triggering_event: {
      type: triggerEvent.type,
      summary: triggerSummary,
      detail: `<untrusted_event_data>\n${JSON.stringify(sanitizeEventData(triggerEvent.data), null, 2)}\n</untrusted_event_data>`,
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
