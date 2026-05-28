/**
 * FHIR R4 Procedure resource generator (issue #387).
 *
 * Maps internal procedure rows to the HL7 FHIR R4 Procedure resource
 * (https://hl7.org/fhir/R4/procedure.html). CPT codes attach to
 * Procedure.code via the AMA CPT system; ICD-10 reason codes attach to
 * Procedure.reasonCode via the CM value set.
 *
 * CPT emission is gated behind FHIR_CPT_EMISSION_ENABLED (issue #939).
 * AMA licenses CPT codes; distributing them in a FHIR bundle to an
 * external recipient may require an AMA license. Until that's confirmed
 * the flag defaults off — Procedure.code falls back to the free-text
 * procedure name. See docs/fhir-licensing.md.
 */

import { createLogger } from "@carebridge/logger";
import type { procedures } from "@carebridge/db-schema";
import type { FhirProcedure } from "../types/fhir-r4.js";
import { US_CORE_PROCEDURE } from "./us-core-profiles.js";

type ProcedureRow = typeof procedures.$inferSelect;

const CPT_SYSTEM = "http://www.ama-assn.org/go/cpt";
const ICD10_CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";

const logger = createLogger("fhir-gateway");

function isCptEmissionEnabled(): boolean {
  return process.env.FHIR_CPT_EMISSION_ENABLED === "true";
}

/**
 * One-time-per-process operator breadcrumb for the AMA CPT licensing gate
 * (#1251). When a procedure row carries a `cpt_code` but the gate is closed,
 * the gateway silently falls back to the free-text procedure name. Without a
 * log line this misconfig is undiagnosable in prod — operators can't tell
 * whether their downstream consumer "doesn't see CPT codes" because no rows
 * have one or because the env flag was set to "True" / "1" / "yes" instead
 * of the literal "true" the gate requires.
 *
 * Intentionally:
 *   - logged at most once per process (suppressionLoggedOnce latch)
 *   - does NOT include the suppressed cpt_code value itself — the log
 *     stream may have a different licensing posture than the FHIR bundle
 *   - includes the env flag name so operators can connect log → env var
 */
let suppressionLoggedOnce = false;
function noteCptSuppression(): void {
  if (suppressionLoggedOnce) return;
  suppressionLoggedOnce = true;
  logger.info("CPT coding suppressed by licensing gate", {
    flag: "FHIR_CPT_EMISSION_ENABLED",
  });
}

/** Test-only: reset the one-shot latch so unit tests can re-trigger the log. */
export function __resetCptSuppressionLogForTests(): void {
  suppressionLoggedOnce = false;
}

/**
 * FHIR R4 ProcedureStatus value set. Internal statuses "scheduled" and
 * "cancelled" don't exactly match — we remap them ("scheduled" → preparation,
 * "cancelled" → stopped) so downstream FHIR consumers see only spec-valid
 * values.
 */
function mapProcedureStatus(status: string): FhirProcedure["status"] {
  switch (status.toLowerCase()) {
    case "scheduled":
    case "preparation":
      return "preparation";
    case "in-progress":
    case "in_progress":
      return "in-progress";
    case "completed":
    case "done":
    case "finished":
      return "completed";
    case "cancelled":
    case "canceled":
    case "stopped":
      return "stopped";
    case "on-hold":
    case "hold":
      return "on-hold";
    case "not-done":
    case "abandoned":
      return "not-done";
    case "entered-in-error":
      return "entered-in-error";
    default:
      return "unknown";
  }
}

export function toFhirProcedure(
  procedure: ProcedureRow,
  patientId: string,
): FhirProcedure {
  const resource: FhirProcedure = {
    resourceType: "Procedure",
    id: procedure.id,
    meta: {
      profile: [US_CORE_PROCEDURE],
    },
    status: mapProcedureStatus(procedure.status),
    subject: {
      reference: `Patient/${patientId}`,
    },
  };

  // Procedure.code: emit CPT coding only when FHIR_CPT_EMISSION_ENABLED is
  // explicitly enabled (#939 — AMA CPT licensing gate). Otherwise fall back
  // to the free-text procedure name so the resource stays useful to
  // downstream consumers without distributing licensed CPT identifiers.
  if (procedure.cpt_code && isCptEmissionEnabled()) {
    resource.code = {
      coding: [
        {
          system: CPT_SYSTEM,
          code: procedure.cpt_code,
          display: procedure.name,
        },
      ],
      text: procedure.name,
    };
  } else if (procedure.name) {
    if (procedure.cpt_code) {
      // cpt_code was present but the gate is closed — leave a one-shot
      // breadcrumb for operators (#1251).
      noteCptSuppression();
    }
    resource.code = {
      text: procedure.name,
    };
  }

  // ICD-10 reason codes — empty array is treated as "no reason provided"
  // and the field is omitted rather than emitted as an empty list.
  const icd10 = procedure.icd10_codes ?? [];
  if (icd10.length > 0) {
    resource.reasonCode = icd10.map((code) => ({
      coding: [
        {
          system: ICD10_CM_SYSTEM,
          code,
        },
      ],
    }));
  }

  if (procedure.performed_at) {
    resource.performedDateTime = procedure.performed_at;
  }

  if (procedure.performed_by) {
    resource.performer = [
      {
        actor: {
          reference: `Practitioner/${procedure.performed_by}`,
        },
      },
    ];
  }

  return resource;
}
