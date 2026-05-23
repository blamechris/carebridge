/**
 * Epic sync fan-out configuration (#1098).
 *
 * Epic enforces per-resource-type search-parameter restrictions, so the
 * sync worker fans out across a small set of values for the resource
 * types that need it:
 *
 *   - `Observation` — one search per `category` (Epic refuses an
 *     un-categorised search). Defaults: `vital-signs`, `laboratory`.
 *   - `MedicationRequest` — Epic refuses an un-`status`-scoped search.
 *     Defaults: `active`.
 *
 * The MVP defaults match what the persistence layer can actually
 * import (vitals + lab_results, active meds) and what the AI oversight
 * pipeline acts on. A primary-care or med-rec tenant whose workflow
 * needs other categories/statuses can override via env without a code
 * change.
 *
 * Env vars:
 *   EPIC_OBSERVATION_CATEGORIES       — Comma-separated FHIR
 *     observation-category codes (e.g. `vital-signs,social-history`).
 *     Whitespace around entries is trimmed; empty segments and
 *     duplicates are dropped. An all-empty value falls back to the
 *     default (silently disabling Observation sync is worse than
 *     refusing the misconfig).
 *   EPIC_MEDICATION_REQUEST_STATUS    — Single FHIR MedicationRequest
 *     status code. Multi-status fan-out lives in #1105 (skipped test
 *     placeholder in sync-jobs.test.ts).
 */

export const DEFAULT_OBSERVATION_CATEGORIES: readonly string[] = [
  "vital-signs",
  "laboratory",
];

export const DEFAULT_MEDICATION_REQUEST_STATUS = "active";

function parseList(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function getObservationCategories(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = parseList(env.EPIC_OBSERVATION_CATEGORIES);
  return override ?? [...DEFAULT_OBSERVATION_CATEGORIES];
}

export function getMedicationRequestStatus(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.EPIC_MEDICATION_REQUEST_STATUS;
  if (raw === undefined) return DEFAULT_MEDICATION_REQUEST_STATUS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_MEDICATION_REQUEST_STATUS;
  return trimmed;
}
