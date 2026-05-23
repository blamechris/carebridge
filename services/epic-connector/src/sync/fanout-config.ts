/**
 * Epic sync fan-out configuration (#1098, #1110, #1111, #1112, #1113).
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
 *     duplicates are dropped. Unknown codes (not in the FHIR R4
 *     `observation-category` CodeSystem) are dropped with a log.warn,
 *     keeping the worker available rather than blocking boot on a
 *     typo. If the entire override is empty or all-invalid, the
 *     defaults are used and a log.warn is emitted once.
 *   EPIC_MEDICATION_REQUEST_STATUS    — Single FHIR MedicationRequest
 *     status code. Unknown values fall back to the default with a
 *     log.warn. Multi-status fan-out implementation is tracked under
 *     #1114; the related `it.skip` test-placeholder cleanup is
 *     tracked under #1105.
 *
 * Caching: `loadFanoutConfig` runs once on first access, then the
 * resolved config is reused for the lifetime of the process — env
 * doesn't change after boot in production. Tests can pass `env`
 * directly to `loadFanoutConfig` for parse/validate behaviour, and
 * call `resetFanoutConfigCacheForTests()` to clear the cache between
 * cases that use the cached getters.
 */
import { createLogger } from "@carebridge/logger";

const log = createLogger("epic-fanout-config");

/**
 * FHIR R4 `observation-category` value-set codes. Source:
 * https://hl7.org/fhir/R4/valueset-observation-category.html
 */
export const VALID_OBSERVATION_CATEGORIES: ReadonlySet<string> = new Set([
  "vital-signs",
  "imaging",
  "laboratory",
  "procedure",
  "survey",
  "exam",
  "therapy",
  "activity",
  "social-history",
]);

/**
 * FHIR R4 `medication-request-status` value-set codes. Source:
 * https://hl7.org/fhir/R4/valueset-medicationrequest-status.html
 */
export const VALID_MEDICATION_REQUEST_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "on-hold",
  "cancelled",
  "completed",
  "entered-in-error",
  "stopped",
  "draft",
  "unknown",
]);

export const DEFAULT_OBSERVATION_CATEGORIES: readonly string[] = [
  "vital-signs",
  "laboratory",
];

export const DEFAULT_MEDICATION_REQUEST_STATUS = "active";

export interface FanoutConfig {
  observationCategories: string[];
  medicationRequestStatus: string;
}

interface ParseResult<T> {
  value: T;
  warning?: { msg: string; meta: Record<string, unknown> };
}

function parseObservationCategories(raw: string | undefined): ParseResult<string[]> {
  if (raw === undefined) return { value: [...DEFAULT_OBSERVATION_CATEGORIES] };

  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (VALID_OBSERVATION_CATEGORIES.has(p)) valid.push(p);
    else invalid.push(p);
  }

  if (valid.length === 0) {
    // All-empty (`""`, `,,,`, `"   "`) or all-invalid → fall back.
    // Silently disabling Observation sync is worse than refusing the
    // misconfig; emit a warning so the operator sees their override
    // didn't take effect.
    return {
      value: [...DEFAULT_OBSERVATION_CATEGORIES],
      warning: {
        msg: "EPIC_OBSERVATION_CATEGORIES set but produced no valid categories, using default fan-out",
        meta: {
          raw,
          invalidCodes: invalid,
          fallback: [...DEFAULT_OBSERVATION_CATEGORIES],
        },
      },
    };
  }

  if (invalid.length > 0) {
    // Partial misconfig — keep the valid ones, warn about the typos.
    return {
      value: valid,
      warning: {
        msg: "EPIC_OBSERVATION_CATEGORIES contains unknown FHIR observation-category codes, dropping",
        meta: { raw, invalidCodes: invalid, kept: valid },
      },
    };
  }

  return { value: valid };
}

function parseMedicationRequestStatus(raw: string | undefined): ParseResult<string> {
  if (raw === undefined) return { value: DEFAULT_MEDICATION_REQUEST_STATUS };

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      value: DEFAULT_MEDICATION_REQUEST_STATUS,
      warning: {
        msg: "EPIC_MEDICATION_REQUEST_STATUS set but parsed empty, using default",
        meta: { raw, fallback: DEFAULT_MEDICATION_REQUEST_STATUS },
      },
    };
  }

  if (!VALID_MEDICATION_REQUEST_STATUSES.has(trimmed)) {
    return {
      value: DEFAULT_MEDICATION_REQUEST_STATUS,
      warning: {
        msg: "EPIC_MEDICATION_REQUEST_STATUS is not a known FHIR medication-request-status code, using default",
        meta: { raw: trimmed, fallback: DEFAULT_MEDICATION_REQUEST_STATUS },
      },
    };
  }

  return { value: trimmed };
}

/**
 * Parse + validate fan-out env. Pure with respect to the supplied env
 * map (no caching). Logs warnings as a side-effect for misconfigs.
 */
export function loadFanoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): FanoutConfig {
  const cats = parseObservationCategories(env.EPIC_OBSERVATION_CATEGORIES);
  const status = parseMedicationRequestStatus(env.EPIC_MEDICATION_REQUEST_STATUS);
  if (cats.warning) log.warn(cats.warning.msg, cats.warning.meta);
  if (status.warning) log.warn(status.warning.msg, status.warning.meta);
  return {
    observationCategories: cats.value,
    medicationRequestStatus: status.value,
  };
}

let cached: FanoutConfig | null = null;

/**
 * Returns the resolved fan-out config, loading + caching on first
 * access. Subsequent calls in the same process reuse the cached value.
 */
export function getFanoutConfig(): FanoutConfig {
  if (cached === null) cached = loadFanoutConfig();
  return cached;
}

/**
 * Clear the cached config — test-only. Production code should never
 * call this; env doesn't change after boot.
 */
export function resetFanoutConfigCacheForTests(): void {
  cached = null;
}

export function getObservationCategories(): string[] {
  return getFanoutConfig().observationCategories;
}

export function getMedicationRequestStatus(): string {
  return getFanoutConfig().medicationRequestStatus;
}
