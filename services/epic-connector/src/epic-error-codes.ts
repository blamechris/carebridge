/**
 * Epic FHIR error codes the connector reasons about structurally (#1102).
 *
 * Epic returns OperationOutcome resources on failure with a numeric code
 * in `issue[*].details.coding[*].code`. The connector uses these codes
 * to discriminate failure categories — soft-skip vs surface, retry vs
 * fail — without depending on Epic's human-readable error text.
 *
 * Add to this registry rather than hardcoding the literal in a call
 * site so future code-based checks stay searchable + autocomplete-aware,
 * and so each entry's policy (skip / surface / retry) lives next to
 * the code it applies to.
 *
 * Reference: Epic on FHIR error codes (`open.epic.com` → API docs →
 * Error Handling). Codes are stable across Epic versions.
 */

export const EPIC_ERROR_CODES = {
  /**
   * "Combination of parameters is not valid for any authorized
   * sub-resource. No search was performed."
   *
   * Policy: SOFT-SKIP. The registered Epic app lacks the scope for the
   * requested filter combination (e.g. `Observation?category=vital-signs`
   * when the app's contracts cover laboratory only). The sync worker
   * records the skip in `epic_sync_state.skipped_sub_resources` and
   * keeps the rest of the patient's sync going.
   */
  UNAUTHORIZED_SUB_RESOURCE: "59022",

  /**
   * "A required element is missing."
   *
   * Policy: SURFACE. The request shape is wrong — typically a missing
   * required search parameter. Distinct from 59022 because the app
   * may have the scope; the request itself is malformed. Bubbles up
   * to BullMQ as a sync error so it's investigated, not silenced.
   */
  MISSING_REQUIRED_ELEMENT: "59108",
} as const;

export type EpicErrorCode =
  (typeof EPIC_ERROR_CODES)[keyof typeof EPIC_ERROR_CODES];
