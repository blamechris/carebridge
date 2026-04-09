/**
 * Phase C1 — unified problem-list service.
 *
 * Builds a single aggregated list of a patient's active problems that the
 * clinician portal renders on the Problem List tab. The input is spread
 * across four tables:
 *
 *   - `diagnoses` (active rows only)
 *   - `care_team_members` (active roster, for managing specialists)
 *   - `clinical_notes` (most recent signed note per-patient, used as a
 *     "last touched" approximation since notes aren't yet linked to a
 *     specific diagnosis — see Phase C3 for proper per-problem linkage)
 *   - `clinical_flags` (open flag count per patient)
 *
 * All structured reads are parallelized. Heavy per-problem joining is done
 * in memory once since per-patient data sizes are small.
 *
 * Staleness is computed server-side in whole days so the UI doesn't have
 * to know about the server's "now" clock.
 */

import { and, desc, eq, isNotNull, inArray, sql } from "drizzle-orm";
import {
  getDb,
  diagnoses,
  careTeamMembers,
  clinicalNotes,
  clinicalFlags,
  users,
} from "@carebridge/db-schema";
import type { UnifiedProblem } from "@carebridge/shared-types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, toIso: string): number {
  const diff = Date.parse(toIso) - Date.parse(fromIso);
  if (Number.isNaN(diff)) return 0;
  return Math.max(0, Math.floor(diff / MS_PER_DAY));
}

/**
 * Fetches the unified problem list for a patient.
 *
 * Returns an array sorted by last_touched_at descending — freshest
 * problems first, so stale orphans drop to the bottom where the UI can
 * highlight them.
 */
export async function getProblemListByPatient(
  patientId: string,
  now: Date = new Date(),
): Promise<UnifiedProblem[]> {
  const db = getDb();
  const nowIso = now.toISOString();

  const [
    diagnosisRows,
    careTeamRows,
    recentSignedNoteRows,
    openFlagCountResult,
  ] = await Promise.all([
    db
      .select()
      .from(diagnoses)
      .where(
        and(
          eq(diagnoses.patient_id, patientId),
          sql`${diagnoses.status} != 'resolved'`,
        ),
      ),
    db
      .select()
      .from(careTeamMembers)
      .where(
        and(
          eq(careTeamMembers.patient_id, patientId),
          eq(careTeamMembers.is_active, true),
        ),
      ),
    // Most recent signed note per patient — used as "last touched"
    // approximation. We take up to 5 so we can attach the freshest one
    // and keep runway for Phase C3 when we join per-problem.
    db
      .select({
        id: clinicalNotes.id,
        provider_id: clinicalNotes.provider_id,
        template_type: clinicalNotes.template_type,
        signed_at: clinicalNotes.signed_at,
      })
      .from(clinicalNotes)
      .where(
        and(
          eq(clinicalNotes.patient_id, patientId),
          isNotNull(clinicalNotes.signed_at),
        ),
      )
      .orderBy(desc(clinicalNotes.signed_at))
      .limit(5),
    db
      .select({ count: sql<number>`count(*)` })
      .from(clinicalFlags)
      .where(
        and(
          eq(clinicalFlags.patient_id, patientId),
          eq(clinicalFlags.status, "open"),
        ),
      ),
  ]);

  if (diagnosisRows.length === 0) return [];

  // Resolve provider specialty for each distinct provider touching
  // either the diagnosis or the care team or the most-recent note.
  const providerIds = Array.from(
    new Set(
      [
        ...careTeamRows.map((r) => r.provider_id),
        ...recentSignedNoteRows.map((r) => r.provider_id),
        ...diagnosisRows.map((d) => d.diagnosed_by).filter(Boolean),
      ].filter((id): id is string => Boolean(id)),
    ),
  );

  const providerRows = providerIds.length
    ? await db
        .select({ id: users.id, specialty: users.specialty })
        .from(users)
        .where(inArray(users.id, providerIds))
    : [];

  const specialtyById = new Map<string, string | null>();
  for (const row of providerRows) {
    specialtyById.set(row.id, row.specialty);
  }

  const openFlagCount = Number(openFlagCountResult[0]?.count ?? 0);

  // The most-recent signed note across the whole patient is the best
  // approximation we have today for "last touched" on each problem.
  // Phase C3 will refine this by scanning Phase A1 assertions for the
  // problem's name. For now every active problem shares the same note.
  const mostRecentNote = recentSignedNoteRows[0] ?? null;
  const mostRecentNoteDto = mostRecentNote
    ? {
        id: mostRecentNote.id,
        provider_id: mostRecentNote.provider_id,
        provider_specialty:
          specialtyById.get(mostRecentNote.provider_id) ?? null,
        template_type: mostRecentNote.template_type,
        signed_at: mostRecentNote.signed_at ?? null,
      }
    : null;

  const managingSpecialists = careTeamRows.map((row) => ({
    provider_id: row.provider_id,
    role: row.role,
    specialty: row.specialty ?? specialtyById.get(row.provider_id) ?? null,
  }));

  const problems: UnifiedProblem[] = diagnosisRows.map((row) => {
    const diagnosisTouchedAt = row.created_at;
    const noteTouchedAt = mostRecentNoteDto?.signed_at ?? null;
    const lastTouchedAt =
      noteTouchedAt && noteTouchedAt > diagnosisTouchedAt
        ? noteTouchedAt
        : diagnosisTouchedAt;

    return {
      diagnosis_id: row.id,
      patient_id: row.patient_id,
      description: row.description ?? "",
      icd10_code: row.icd10_code ?? null,
      snomed_code: row.snomed_code ?? null,
      status: row.status,
      onset_date: row.onset_date ?? null,
      diagnosed_by: row.diagnosed_by ?? null,
      managing_specialists: managingSpecialists,
      most_recent_note: mostRecentNoteDto,
      open_flag_count: openFlagCount,
      last_touched_at: lastTouchedAt,
      stale_days: daysBetween(lastTouchedAt, nowIso),
    };
  });

  problems.sort((a, b) => b.last_touched_at.localeCompare(a.last_touched_at));

  return problems;
}
