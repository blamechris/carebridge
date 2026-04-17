/**
 * Event-time snapshot helpers shared by the rule-path
 * (`buildPatientContextForRules` in review-service) and the LLM-path
 * (`buildPatientContext` in context-builder).
 *
 * Keeping both paths on the same primitives guarantees that the
 * deterministic rules and the LLM reason over identical row sets for a
 * given trigger event — see #258, #512, #513, #515.
 *
 * ─── Timestamp comparison (#513) ──────────────────────────────────────
 * ISO-8601 strings only sort correctly under lexicographic compare when
 * every operand is strict UTC Z-form (`YYYY-MM-DDTHH:MM:SS.sssZ`). FHIR
 * importers and seed data routinely emit offset-form values (`-05:00`)
 * or bare dates (`2025-12-01`), which silently mis-compare near day
 * boundaries. Normalizing through `Date.parse` handles every ISO-8601
 * variant the platform ingests.
 *
 * ─── Logical retraction (#515) ────────────────────────────────────────
 * A row marked `entered_in_error` (diagnoses, medications) or
 * `entered_in_error` / `refuted` (allergies) is a charting correction.
 * It was never clinically true and must never drive rule or LLM output,
 * regardless of its timestamps.
 */

/**
 * Parse an ISO-8601 timestamp to a numeric epoch. Returns `NaN` for
 * missing / malformed input — the caller decides how to treat that.
 */
function toEpoch(iso: string | null | undefined): number {
  if (iso == null) return Number.NaN;
  return Date.parse(iso);
}

/**
 * Is `a` strictly before `b`? Returns `false` when either operand is
 * unparseable — matching the prior string-compare behavior on
 * undefined/invalid input (no row is considered "strictly before"
 * garbage). Callers that need stricter validation should validate
 * upstream.
 */
export function isoBefore(a: string | null | undefined, b: string | null | undefined): boolean {
  const ea = toEpoch(a);
  const eb = toEpoch(b);
  if (Number.isNaN(ea) || Number.isNaN(eb)) return false;
  return ea < eb;
}

/**
 * Is `a` less-than-or-equal to `b`? Returns `false` when either operand
 * is unparseable (see `isoBefore`).
 */
export function isoLTE(a: string | null | undefined, b: string | null | undefined): boolean {
  const ea = toEpoch(a);
  const eb = toEpoch(b);
  if (Number.isNaN(ea) || Number.isNaN(eb)) return false;
  return ea <= eb;
}

/**
 * Logical retraction for a diagnosis row. `status === 'entered_in_error'`
 * means a clinician struck it as a charting mistake — it is NOT a real
 * condition and must never appear in the active set. Note that `resolved`
 * and `chronic` are legitimate active-history states and handled by the
 * `resolved_date` check upstream, not here.
 */
export function isDiagnosisRetracted(row: { status?: string | null }): boolean {
  return row.status === "entered_in_error";
}

/**
 * Logical retraction for an allergy row. `entered_in_error` is a charting
 * correction; `refuted` means the allergy was tested and disproven. Both
 * must be excluded from rule evaluation and LLM context.
 */
export function isAllergyRetracted(row: { verification_status?: string | null }): boolean {
  return (
    row.verification_status === "entered_in_error" ||
    row.verification_status === "refuted"
  );
}

/**
 * Logical retraction for a medication row. `status === 'entered_in_error'`
 * means the prescription was recorded by mistake — it was never actually
 * ordered and must be excluded from drug-interaction checks, allergy
 * cross-refs, and LLM context. See #581.
 */
export function isMedicationRetracted(row: { status?: string | null }): boolean {
  return row.status === "entered_in_error";
}
