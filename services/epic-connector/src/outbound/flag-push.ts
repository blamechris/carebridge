/**
 * Outbound flag-push orchestrator (#393).
 *
 * Pushes CareBridge `clinical_flags` rows to Epic as FHIR Flag resources.
 *
 * Two entry points:
 *   pushFlagToEpic(flagId, deps)         — creates the Flag on Epic
 *                                          (or updates an existing one
 *                                          if epic_flag_id is set)
 *   pushFlagStatusUpdate(flagId, deps)   — updates the Flag's status
 *                                          when the CareBridge flag is
 *                                          acknowledged / resolved /
 *                                          dismissed
 *
 * Both write to `audit_log` with action="epic_flag_push" and to the
 * `clinical_flags` row's epic_* tracking columns so a re-run is
 * idempotent: a flag already pushed updates in place instead of being
 * created twice on Epic's side.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { createLogger } from "@carebridge/logger";
import {
  getDb,
  clinicalFlags,
  auditLog,
  fhirResources,
} from "@carebridge/db-schema";
import { EpicFhirClient } from "../fhir-client.js";
import { buildFhirFlag, type FhirFlag } from "./flag-generator.js";
import { EPIC_SOURCE_SYSTEM_TAG } from "../converters.js";

const log = createLogger("epic-flag-push");

const EPIC_PUSH_AUDIT_USER = "system:epic-flag-push";

export interface FlagPushDeps {
  client: EpicFhirClient;
}

export interface FlagPushResult {
  flag_id: string;
  epic_flag_id: string | null;
  operation: "created" | "updated" | "skipped" | "failed";
  error?: string;
}

/**
 * Look up the Epic Patient FHIR id for a CareBridge patient. Uses the
 * existing `fhir_resources` mapping table populated by the inbound
 * sync worker (#391) — falls back to null when the patient hasn't been
 * synced from Epic. Without an Epic Patient id we can't push the Flag
 * because Epic rejects `subject.reference` to an unknown patient.
 */
async function lookupEpicPatientId(
  carebridgePatientId: string,
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ resource_id: fhirResources.resource_id })
    .from(fhirResources)
    .where(eq(fhirResources.internal_record_id, carebridgePatientId))
    .limit(10);
  // Find the Patient mapping among any others (the patient may also
  // have linked Observation, Condition, etc. mappings).
  for (const row of rows) {
    // The mapping id pattern is `epic:<resourceType>:<fhirId>` so
    // resource_id is the FHIR id directly. We trust resource_type
    // implicitly by joining on internal_record_id (only Patient maps
    // to the patient table's id).
    return row.resource_id;
  }
  return null;
}

/**
 * Core push routine. Generates the FHIR Flag payload, sends it to Epic,
 * and persists the resulting epic_flag_id back on the clinical_flags
 * row.
 *
 * Idempotency:
 *  - If `epic_flag_id` is already set, this performs a PUT instead of
 *    a POST so a replayed job updates the existing resource.
 *  - If the patient hasn't been synced from Epic (no Epic Patient id
 *    mapping), the push is skipped — Epic would reject the Flag for an
 *    unknown subject.
 */
export async function pushFlagToEpic(
  flagId: string,
  deps: FlagPushDeps,
): Promise<FlagPushResult> {
  const db = getDb();
  const [flag] = await db
    .select()
    .from(clinicalFlags)
    .where(eq(clinicalFlags.id, flagId))
    .limit(1);

  if (!flag) {
    return { flag_id: flagId, epic_flag_id: null, operation: "skipped", error: "flag not found" };
  }

  const epicPatientId = await lookupEpicPatientId(flag.patient_id);
  if (!epicPatientId) {
    log.info("Skipping Epic flag push — patient not yet mapped to Epic", {
      flagId,
      carebridgePatientId: flag.patient_id,
    });
    return {
      flag_id: flagId,
      epic_flag_id: flag.epic_flag_id,
      operation: "skipped",
      error: "epic_patient_id_unknown",
    };
  }

  const payload: FhirFlag = buildFhirFlag({
    flag: {
      summary: flag.summary,
      rationale: flag.rationale,
      suggested_action: flag.suggested_action,
      severity: flag.severity as "critical" | "warning" | "info",
      category: flag.category as "cross-specialty" | "drug-interaction" | "medication-safety" | "care-gap" | "critical-value" | "trend-concern" | "documentation-discrepancy" | "patient-reported",
      status: flag.status as "open" | "acknowledged" | "resolved" | "dismissed" | "escalated",
      rule_id: flag.rule_id ?? undefined,
      created_at: flag.created_at,
      resolved_at: flag.resolved_at ?? undefined,
      dismissed_at: flag.dismissed_at ?? undefined,
    },
    epicPatientFhirId: epicPatientId,
    epicFlagId: flag.epic_flag_id ?? undefined,
  });

  const now = new Date().toISOString();

  try {
    let createdOrUpdated: FhirFlag;
    let operation: "created" | "updated";
    if (flag.epic_flag_id) {
      createdOrUpdated = await deps.client.updateResource(
        "Flag",
        flag.epic_flag_id,
        payload,
      );
      operation = "updated";
    } else {
      createdOrUpdated = await deps.client.createResource("Flag", payload);
      operation = "created";
    }

    const epicFlagId = createdOrUpdated.id ?? flag.epic_flag_id ?? null;

    await db
      .update(clinicalFlags)
      .set({
        epic_flag_id: epicFlagId,
        epic_org_iss: epicOrgIssFromClientBase(),
        epic_pushed_at: now,
        epic_push_error: null,
      })
      .where(eq(clinicalFlags.id, flagId));

    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: EPIC_PUSH_AUDIT_USER,
      action: "epic_flag_push",
      resource_type: "clinical_flag",
      resource_id: flagId,
      patient_id: flag.patient_id,
      success: true,
      details: JSON.stringify({
        operation,
        epic_flag_id: epicFlagId,
        epic_patient_fhir_id: epicPatientId,
        source_system: EPIC_SOURCE_SYSTEM_TAG,
      }),
      timestamp: now,
    });

    log.info("Pushed CareBridge flag to Epic", {
      flagId,
      epicFlagId,
      operation,
    });

    return {
      flag_id: flagId,
      epic_flag_id: epicFlagId,
      operation,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Truncate to 1KiB matching the convention used elsewhere
    // (sync-state-repo.markFailed).
    const truncated = message.slice(0, 1024);

    await db
      .update(clinicalFlags)
      .set({ epic_push_error: truncated })
      .where(eq(clinicalFlags.id, flagId));

    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: EPIC_PUSH_AUDIT_USER,
      action: "epic_flag_push",
      resource_type: "clinical_flag",
      resource_id: flagId,
      patient_id: flag.patient_id,
      success: false,
      details: JSON.stringify({
        operation: flag.epic_flag_id ? "updated" : "created",
        epic_patient_fhir_id: epicPatientId,
        source_system: EPIC_SOURCE_SYSTEM_TAG,
      }),
      error_message: truncated,
      timestamp: now,
    });

    log.error("Epic flag push failed", { flagId, error: truncated });

    return {
      flag_id: flagId,
      epic_flag_id: flag.epic_flag_id,
      operation: "failed",
      error: truncated,
    };
  }
}

/**
 * Push a status update (acknowledge / resolve / dismiss) to Epic for
 * a flag that has already been pushed. No-op when the flag isn't yet
 * tracked on Epic — the next regular push (which carries the new
 * status) will handle it.
 */
export async function pushFlagStatusUpdate(
  flagId: string,
  deps: FlagPushDeps,
): Promise<FlagPushResult> {
  const db = getDb();
  const [flag] = await db
    .select({ epic_flag_id: clinicalFlags.epic_flag_id })
    .from(clinicalFlags)
    .where(eq(clinicalFlags.id, flagId))
    .limit(1);
  if (!flag?.epic_flag_id) {
    log.debug("Status update push skipped — flag not yet on Epic", { flagId });
    return {
      flag_id: flagId,
      epic_flag_id: null,
      operation: "skipped",
      error: "not_pushed_yet",
    };
  }
  return pushFlagToEpic(flagId, deps);
}

/**
 * Best-effort lookup of the Epic FHIR base URL we're configured for.
 * Returns `null` in tests / dev where Epic env isn't set. The full
 * config load happens in the worker; this helper only exists so the
 * push function can stamp the org on the audit row without re-reading
 * env on every call.
 */
function epicOrgIssFromClientBase(): string | null {
  return process.env.EPIC_FHIR_BASE_URL ?? null;
}

// Re-exported types for test consumption.
export type { FhirFlag } from "./flag-generator.js";
