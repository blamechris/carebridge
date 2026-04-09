/**
 * Phase D P1 — patient AI consent gate.
 *
 * The deterministic rules pass runs unconditionally: the rules operate on
 * data the patient has already agreed to share with their care team and
 * never leave the CareBridge perimeter. The LLM review path is different
 * — it transmits derived clinical context (post-redaction) to Anthropic
 * under the BAA, and every patient must explicitly opt in before any of
 * their data can participate.
 *
 * This module is the single point of truth for that gate:
 *
 *   - {@link hasActiveAiConsent} is a boolean query used by the review
 *     pipeline right before the LLM call. It returns false fast when no
 *     grant exists; the caller then degrades to rules-only and logs the
 *     reason.
 *   - {@link getActiveAiConsent} returns the underlying grant row for
 *     auditing and policy-version checks.
 *   - {@link grantAiConsent} / {@link revokeAiConsent} drive the
 *     lifecycle. Both are append-only — revocation flips a flag, never
 *     deletes the row.
 *
 * Default is DENY. A missing row means the patient never opted in. An
 * older row with a non-null `revoked_at` means the patient opted out.
 * Both paths produce the same result at the gate: no LLM traffic.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, patientAiConsent } from "@carebridge/db-schema";
import type { AiConsentScope } from "@carebridge/db-schema";

export type { AiConsentScope };

export interface ActiveAiConsent {
  id: string;
  patient_id: string;
  scope: AiConsentScope;
  policy_version: string;
  granted_by_user_id: string;
  granted_by_relationship: string;
  granted_at: string;
}

export interface GrantAiConsentInput {
  patient_id: string;
  scope: AiConsentScope;
  policy_version: string;
  granted_by_user_id: string;
  granted_by_relationship: string;
}

/**
 * Return the currently active consent grant for a patient + scope, or
 * null if no unrevoked grant exists. "Active" is defined as the most
 * recent row where `revoked_at IS NULL`.
 */
export async function getActiveAiConsent(
  patientId: string,
  scope: AiConsentScope = "llm_review",
): Promise<ActiveAiConsent | null> {
  const db = getDb();

  const rows = await db
    .select()
    .from(patientAiConsent)
    .where(
      and(
        eq(patientAiConsent.patient_id, patientId),
        eq(patientAiConsent.scope, scope),
        isNull(patientAiConsent.revoked_at),
      ),
    )
    .orderBy(desc(patientAiConsent.granted_at))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    patient_id: row.patient_id,
    scope: row.scope as AiConsentScope,
    policy_version: row.policy_version,
    granted_by_user_id: row.granted_by_user_id,
    granted_by_relationship: row.granted_by_relationship,
    granted_at: row.granted_at,
  };
}

/**
 * Fast boolean check used by the LLM gate in review-service. Avoids
 * returning the underlying row to callers that only need "go / no-go".
 */
export async function hasActiveAiConsent(
  patientId: string,
  scope: AiConsentScope = "llm_review",
): Promise<boolean> {
  return (await getActiveAiConsent(patientId, scope)) !== null;
}

/**
 * Insert a new consent grant. Does NOT check for an existing active
 * grant — the caller is expected to be the patient portal or intake
 * workflow and layering semantics (re-grant, grant-after-revoke) are
 * handled at the application level.
 */
export async function grantAiConsent(
  input: GrantAiConsentInput,
  now: Date = new Date(),
): Promise<ActiveAiConsent> {
  const db = getDb();

  const id = crypto.randomUUID();
  const nowIso = now.toISOString();

  await db.insert(patientAiConsent).values({
    id,
    patient_id: input.patient_id,
    scope: input.scope,
    policy_version: input.policy_version,
    granted_by_user_id: input.granted_by_user_id,
    granted_by_relationship: input.granted_by_relationship,
    granted_at: nowIso,
    revoked_at: null,
    revoked_by_user_id: null,
    revocation_reason: null,
    created_at: nowIso,
  });

  return {
    id,
    patient_id: input.patient_id,
    scope: input.scope,
    policy_version: input.policy_version,
    granted_by_user_id: input.granted_by_user_id,
    granted_by_relationship: input.granted_by_relationship,
    granted_at: nowIso,
  };
}

/**
 * Revoke an active consent grant. Idempotent: calling twice on an
 * already-revoked grant is a no-op. Returns true if a row transitioned
 * from active→revoked, false otherwise.
 */
export async function revokeAiConsent(
  patientId: string,
  revokedByUserId: string,
  reason: string,
  scope: AiConsentScope = "llm_review",
  now: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const active = await getActiveAiConsent(patientId, scope);
  if (!active) return false;

  await db
    .update(patientAiConsent)
    .set({
      revoked_at: now.toISOString(),
      revoked_by_user_id: revokedByUserId,
      revocation_reason: reason,
    })
    .where(eq(patientAiConsent.id, active.id));

  return true;
}
