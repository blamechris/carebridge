/**
 * Flag CRUD service.
 *
 * Handles creation, acknowledgment, resolution, and dismissal of clinical flags.
 * Every flag state transition is a permanent record — flags are never deleted,
 * only moved through their lifecycle.
 */

import { eq, and, gte, sql } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import { clinicalFlags } from "@carebridge/db-schema";
import type { ClinicalFlag, FlagStatus } from "@carebridge/shared-types";
import {
  recordFlagCreated,
  recordFlagDismissed,
  recordFlagResolved,
} from "./shadow-metrics.js";

// 24 hours in milliseconds — window for LLM flag deduplication
const LLM_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Create a new clinical flag.
 *
 * Before inserting, checks for an existing open flag that would be a duplicate:
 *  - Rule-based flags: dedup on (patient_id, rule_id, status='open')
 *  - LLM flags (no rule_id): dedup on (patient_id, category, severity, status='open')
 *    within the last 24 hours to avoid suppressing genuinely new findings.
 *
 * Returns the existing flag if a duplicate is found, otherwise inserts and returns the new one.
 */
export async function createFlag(
  flag: Omit<ClinicalFlag, "id" | "created_at">,
): Promise<ClinicalFlag> {
  const db = getDb();

  // Check for existing open duplicate before inserting
  if (flag.rule_id) {
    // Rule-based flag: exact match on (patient_id, rule_id, status='open')
    const existing = await db
      .select()
      .from(clinicalFlags)
      .where(
        and(
          eq(clinicalFlags.patient_id, flag.patient_id),
          eq(clinicalFlags.rule_id, flag.rule_id),
          eq(clinicalFlags.status, "open"),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return existing[0] as unknown as ClinicalFlag;
    }
  } else {
    // LLM-generated flag: dedup on (patient_id, category, severity, status='open')
    // within the last 24 hours
    const windowStart = new Date(Date.now() - LLM_DEDUP_WINDOW_MS).toISOString();

    const existing = await db
      .select()
      .from(clinicalFlags)
      .where(
        and(
          eq(clinicalFlags.patient_id, flag.patient_id),
          eq(clinicalFlags.category, flag.category),
          eq(clinicalFlags.severity, flag.severity),
          eq(clinicalFlags.status, "open"),
          gte(clinicalFlags.created_at, windowStart),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return existing[0] as unknown as ClinicalFlag;
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const requiresHumanReview =
    flag.requires_human_review ?? flag.source === "ai-review";

  const record = {
    id,
    ...flag,
    requires_human_review: requiresHumanReview ? 1 : 0,
    created_at: now,
  };

  await db.insert(clinicalFlags).values(record);

  recordFlagCreated({ rule_id: flag.rule_id, source: flag.source });

  return { ...record, requires_human_review: requiresHumanReview } as unknown as ClinicalFlag;
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

  const row = await db
    .select({ rule_id: clinicalFlags.rule_id, source: clinicalFlags.source })
    .from(clinicalFlags)
    .where(eq(clinicalFlags.id, flagId))
    .limit(1);
  recordFlagResolved({
    rule_id: row[0]?.rule_id ?? undefined,
    source: row[0]?.source as ClinicalFlag["source"] | undefined,
  });
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

  const row = await db
    .select({ rule_id: clinicalFlags.rule_id, source: clinicalFlags.source })
    .from(clinicalFlags)
    .where(eq(clinicalFlags.id, flagId))
    .limit(1);
  recordFlagDismissed({
    rule_id: row[0]?.rule_id ?? undefined,
    source: row[0]?.source as ClinicalFlag["source"] | undefined,
  });
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
 * Get all open flags across all patients (for the clinician inbox).
 */
export async function getAllOpenFlags(): Promise<ClinicalFlag[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(clinicalFlags)
    .where(eq(clinicalFlags.status, "open"));
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
