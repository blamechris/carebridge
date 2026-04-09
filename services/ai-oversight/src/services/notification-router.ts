/**
 * Phase C3 — care team inbox routing.
 *
 * When the review pipeline creates a clinical flag, we want every
 * relevant clinician on the patient's care team to see it in their
 * inbox, not just the provider who happened to trigger the underlying
 * event. This module does that routing.
 *
 * Routing is:
 *   1. Fetch the patient's active care_team_members roster.
 *   2. Normalize each member's specialty to a set of lowercase tokens.
 *   3. Normalize each of the flag's `notify_specialties` to tokens.
 *   4. A member matches if ANY of their specialty tokens matches ANY
 *      of the flag's notify tokens (case-insensitive substring).
 *   5. If no members match OR the flag has no notify_specialties, fall
 *      back to notifying every active care-team member. This is the
 *      "safe default": a flag that might route nowhere ends up visible
 *      to everyone touching the patient.
 *   6. For each matched member, insert a notification row — but only
 *      if no notification already exists for this (flag_id, user_id)
 *      pair. That makes the call idempotent; retrying a review job
 *      never creates duplicate inbox entries.
 *
 * Audit: console-logged for now. Worker-side audit_log integration is
 * tracked as Phase D9.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  careTeamMembers,
  notifications,
} from "@carebridge/db-schema";
import type { FlagSeverity } from "@carebridge/shared-types";

export interface FlagRoutingPayload {
  flag_id: string;
  patient_id: string;
  severity: FlagSeverity;
  category: string;
  summary: string;
  notify_specialties: string[];
  rule_id: string | null;
}

export interface FlagRoutingResult {
  notified_user_ids: string[];
  recipients_matched: number;
  used_fallback: boolean;
  skipped_existing: number;
}

const WORD_CHARS = /[^a-z0-9]+/g;

/**
 * Normalize a specialty string into a set of lowercase word tokens.
 * "Hematology/Oncology" → {"hematology", "oncology"}
 * "Interventional Radiology" → {"interventional", "radiology"}
 * "hematology_oncology" → {"hematology", "oncology"}
 */
export function normalizeSpecialtyTokens(value: string | null): Set<string> {
  if (!value) return new Set();
  const parts = value
    .toLowerCase()
    .split(WORD_CHARS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts);
}

/**
 * True if any token in `memberTokens` is equal to, or is contained
 * within, any token in `flagTokens` (or vice versa). We use substring
 * matching because a care-team row's specialty might be more specific
 * ("interventional_radiology") than the rule's notify label
 * ("radiology"), or the other way around ("hematology_oncology" vs
 * "oncology").
 */
export function specialtyMatches(
  memberTokens: Set<string>,
  flagTokens: Set<string>,
): boolean {
  if (memberTokens.size === 0 || flagTokens.size === 0) return false;
  for (const memberToken of memberTokens) {
    for (const flagToken of flagTokens) {
      if (memberToken === flagToken) return true;
      if (memberToken.length > 3 && flagToken.includes(memberToken)) return true;
      if (flagToken.length > 3 && memberToken.includes(flagToken)) return true;
    }
  }
  return false;
}

/**
 * Build the deep link that takes a clinician from their inbox to the
 * flagged patient's AI Flags tab. Kept relative so environment-specific
 * host configuration stays out of this module.
 */
export function buildFlagLink(patientId: string): string {
  return `/patients/${patientId}?tab=flags`;
}

/**
 * Build the notification title displayed in the clinician inbox list.
 * Keeps each title short and prefixes the severity so the inbox can
 * sort or color-code without parsing the body.
 */
export function buildFlagTitle(payload: FlagRoutingPayload): string {
  const prefix =
    payload.severity === "critical"
      ? "Critical AI flag"
      : payload.severity === "warning"
        ? "AI flag"
        : "AI notice";
  const summary =
    payload.summary.length > 120
      ? payload.summary.slice(0, 117) + "..."
      : payload.summary;
  return `${prefix}: ${summary}`;
}

/**
 * Route a single flag to every relevant clinician on the patient's
 * active care team. Idempotent — safe to call multiple times for the
 * same flag.
 */
export async function routeFlagToCareTeam(
  payload: FlagRoutingPayload,
  now: Date = new Date(),
): Promise<FlagRoutingResult> {
  const db = getDb();

  const members = await db
    .select()
    .from(careTeamMembers)
    .where(
      and(
        eq(careTeamMembers.patient_id, payload.patient_id),
        eq(careTeamMembers.is_active, true),
      ),
    );

  if (members.length === 0) {
    return {
      notified_user_ids: [],
      recipients_matched: 0,
      used_fallback: false,
      skipped_existing: 0,
    };
  }

  const flagTokens = new Set<string>();
  for (const raw of payload.notify_specialties) {
    for (const tok of normalizeSpecialtyTokens(raw)) flagTokens.add(tok);
  }

  // Find matching members. Empty flag tokens → no match, triggers fallback.
  let matched = members.filter((m) =>
    specialtyMatches(normalizeSpecialtyTokens(m.specialty), flagTokens),
  );

  let usedFallback = false;
  if (matched.length === 0) {
    usedFallback = true;
    matched = members;
  }

  // Dedupe by provider_id in case the roster has duplicate rows
  // (a provider appearing on the care team in multiple roles).
  const uniqueProviderIds = Array.from(
    new Set(matched.map((m) => m.provider_id)),
  );

  const notifiedUserIds: string[] = [];
  let skippedExisting = 0;
  const title = buildFlagTitle(payload);
  const link = buildFlagLink(payload.patient_id);
  const nowIso = now.toISOString();

  for (const providerId of uniqueProviderIds) {
    // Idempotency check: has a notification for this (flag, user) already been created?
    const existing = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, providerId),
          eq(notifications.related_flag_id, payload.flag_id),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      skippedExisting += 1;
      continue;
    }

    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      user_id: providerId,
      type: "ai-flag",
      title,
      body: payload.summary,
      link,
      related_flag_id: payload.flag_id,
      is_read: false,
      created_at: nowIso,
    });

    notifiedUserIds.push(providerId);
  }

  console.log(
    `[notification-router] Flag ${payload.flag_id} routed to ` +
      `${notifiedUserIds.length}/${uniqueProviderIds.length} recipient(s) ` +
      `(fallback=${usedFallback}, skipped=${skippedExisting}, ` +
      `patient=${payload.patient_id}, rule=${payload.rule_id ?? "llm"})`,
  );

  return {
    notified_user_ids: notifiedUserIds,
    recipients_matched: uniqueProviderIds.length,
    used_fallback: usedFallback,
    skipped_existing: skippedExisting,
  };
}

/**
 * Batch helper — routes a list of flags created during a review job.
 * Runs sequentially so console output stays readable and the DB load
 * stays gentle. Errors routing individual flags are swallowed so a
 * single bad route never fails the whole review.
 */
export async function routeFlagsToCareTeam(
  flags: FlagRoutingPayload[],
): Promise<void> {
  for (const flag of flags) {
    try {
      await routeFlagToCareTeam(flag);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[notification-router] Failed to route flag ${flag.flag_id}: ${msg}`,
      );
    }
  }
}

// Re-export for tests and review-service integration.
export { sql };
