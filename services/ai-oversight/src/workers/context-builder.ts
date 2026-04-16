/**
 * Assembles the patient context for LLM review.
 *
 * This is the "gather everything" step: pull the patient's full clinical picture
 * from the database so the LLM can reason over the complete record, not just
 * the triggering event in isolation.
 */

import { eq, and, desc, inArray } from "drizzle-orm";
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
import { sanitizeFreeText } from "@carebridge/phi-sanitizer";

import {
  isoBefore,
  isoLTE,
  isDiagnosisRetracted,
  isAllergyRetracted,
} from "../utils/event-time-snapshot.js";

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
 * Was this diagnosis active AS OF `at` (event time)? Mirrors the helper in
 * buildPatientContextForRules so the LLM and rule paths share the same
 * snapshot semantics. See #258 and #512.
 *
 * Excludes logical retractions (status=entered_in_error) per #515 — a
 * charting correction is not clinically true and must not enter the LLM
 * context. Timestamp comparisons go through isoBefore/isoLTE so
 * offset-form and bare-date values normalize correctly (#513).
 */
function diagnosisWasActiveAt(
  row: {
    onset_date?: string | null;
    resolved_date?: string | null;
    status?: string | null;
    created_at: string;
  },
  at: string,
): boolean {
  if (isDiagnosisRetracted(row)) return false;
  const start = row.onset_date ?? row.created_at;
  if (isoBefore(at, start)) return false; // not yet started at event time
  if (row.resolved_date && isoLTE(row.resolved_date, at)) return false; // resolved before event
  return true;
}

/**
 * Build the full patient context needed for LLM clinical review.
 *
 * Filters diagnoses, medications, allergies, vitals, and labs to the
 * patient snapshot AS OF `triggerEvent.timestamp`. This keeps the LLM's
 * view aligned with the deterministic rule-path view (see
 * `buildPatientContextForRules`) so dedup/precedence reasoning compares
 * apples to apples. Without this, a med discontinued between event emit
 * and LLM review would disappear from the LLM context while the rules
 * still see it, producing inconsistent flags. See #258, #512.
 */
export async function buildPatientContext(
  patientId: string,
  triggerEvent: ClinicalEvent,
): Promise<ReviewContext> {
  const db = getDb();
  const eventAt = triggerEvent.timestamp;

  // Run all queries in parallel for speed. We fetch the full history for
  // diagnoses / medications / allergies and then filter in-memory to the
  // event-time snapshot (same approach as the rule context builder;
  // moving the predicate into SQL is tracked in #514).
  const [
    patientRow,
    allDiagnoses,
    allAllergies,
    allMeds,
    allVitals,
    recentPanels,
    recentFlags,
    careTeam,
  ] = await Promise.all([
    db.query.patients.findFirst({
      where: eq(patients.id, patientId),
    }),
    db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
    db.select().from(allergies).where(eq(allergies.patient_id, patientId)),
    db.select().from(medications).where(eq(medications.patient_id, patientId)),
    db
      .select()
      .from(vitals)
      .where(eq(vitals.patient_id, patientId))
      .orderBy(desc(vitals.recorded_at))
      .limit(100),
    db
      .select()
      .from(labPanels)
      .where(eq(labPanels.patient_id, patientId))
      .orderBy(desc(labPanels.collected_at))
      .limit(20),
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

  // Event-time snapshot filtering — diagnoses active at event time.
  const activeDiagnoses = allDiagnoses.filter((d) =>
    diagnosisWasActiveAt(d, eventAt),
  );

  // Event-time snapshot filtering — medications active at event time.
  // A med is active if it started at/before event time AND either is
  // still open (no ended_at) or ended strictly after event time. Falls
  // back to created_at if started_at is null (defensive; see #516).
  const activeMeds = allMeds.filter((m) => {
    const start = m.started_at ?? m.created_at;
    if (isoBefore(eventAt, start)) return false;
    if (m.ended_at && isoLTE(m.ended_at, eventAt)) return false;
    return true;
  });

  // Event-time snapshot — allergies recorded at/before the event.
  // Also exclude logical retractions (entered_in_error, refuted); these
  // are charting corrections and must not appear in the LLM context.
  // See #515.
  const patientAllergies = allAllergies.filter((a) => {
    if (isoBefore(eventAt, a.created_at)) return false;
    if (isAllergyRetracted(a)) return false;
    return true;
  });

  // Event-time snapshot — vitals recorded at/before the event. Keep the
  // 20 most recent eligible rows to match the previous budget.
  const latestVitals = allVitals
    .filter((v) => isoLTE(v.recorded_at, eventAt))
    .slice(0, 20);

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

  // Fetch lab results for recent panels, then filter to pre-event rows.
  // Prevents "future leakage" of labs reported after the triggering event
  // into the LLM context (mirrors the rule-path behavior).
  let recentLabResults: ReviewContext["recent_labs"] = [];
  if (recentPanels.length > 0) {
    const panelIds = recentPanels.map((p) => p.id);
    const allResults = await db
      .select()
      .from(labResults)
      .where(inArray(labResults.panel_id, panelIds));

    recentLabResults = allResults
      .filter((r) => isoLTE(r.created_at, eventAt))
      .slice(0, 50)
      .map((r) => ({
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

  return {
    patient: {
      age,
      sex: patientRow?.biological_sex ?? "unknown",
      allergy_status: (patientRow?.allergy_status as "nkda" | "unknown" | "has_allergies") ?? "unknown",
      active_diagnoses: activeDiagnoses.map((d) => d.description),
      allergies: patientAllergies.map((a) => ({
        allergen: a.allergen,
        verification_status: a.verification_status ?? "unconfirmed",
      })),
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
