/**
 * Flag CRUD service.
 *
 * Handles creation, acknowledgment, resolution, and dismissal of clinical flags.
 * Every flag state transition is a permanent record — flags are never deleted,
 * only moved through their lifecycle.
 */

import { eq, and, sql } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import { clinicalFlags } from "@carebridge/db-schema";
import type { ClinicalFlag, FlagStatus } from "@carebridge/shared-types";

/**
 * Create a new clinical flag.
 */
export async function createFlag(
  flag: Omit<ClinicalFlag, "id" | "created_at">,
): Promise<ClinicalFlag> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const record = {
    id,
    ...flag,
    created_at: now,
  };

  await db.insert(clinicalFlags).values(record);

  return { ...record } as ClinicalFlag;
}

/**
 * Acknowledge a flag — clinician has seen it.
 */
export async function acknowledgeFlag(
  flagId: string,
  userId: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(clinicalFlags)
    .set({
      status: "acknowledged",
      acknowledged_by: userId,
      acknowledged_at: now,
    })
    .where(eq(clinicalFlags.id, flagId));
}

/**
 * Resolve a flag — clinician has addressed the concern.
 */
export async function resolveFlag(
  flagId: string,
  userId: string,
  note: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(clinicalFlags)
    .set({
      status: "resolved",
      resolved_by: userId,
      resolved_at: now,
      resolution_note: note,
    })
    .where(eq(clinicalFlags.id, flagId));
}

/**
 * Dismiss a flag — clinician has reviewed and determined it is not actionable.
 */
export async function dismissFlag(
  flagId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(clinicalFlags)
    .set({
      status: "dismissed",
      dismissed_by: userId,
      dismissed_at: now,
      dismiss_reason: reason,
    })
    .where(eq(clinicalFlags.id, flagId));
}

/**
 * Get flags for a patient, optionally filtered by status.
 */
export async function getFlagsByPatient(
  patientId: string,
  status?: FlagStatus,
): Promise<ClinicalFlag[]> {
  const db = getDb();

  const conditions = status
    ? and(
        eq(clinicalFlags.patient_id, patientId),
        eq(clinicalFlags.status, status),
      )
    : eq(clinicalFlags.patient_id, patientId);

  const rows = await db
    .select()
    .from(clinicalFlags)
    .where(conditions);

  return rows as unknown as ClinicalFlag[];
}

/**
 * Get count of open flags for a patient.
 */
export async function getOpenFlagCount(patientId: string): Promise<number> {
  const db = getDb();

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(clinicalFlags)
    .where(
      and(
        eq(clinicalFlags.patient_id, patientId),
        eq(clinicalFlags.status, "open"),
      ),
    );

  return Number(result[0]?.count ?? 0);
}
