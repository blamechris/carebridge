/**
 * Epic sync fan-out configuration (#1098, #1110, #1111, #1112, #1113, #1114).
 *
 * Epic enforces per-resource-type search-parameter restrictions, so the
 * sync worker fans out across a small set of values for the resource
 * types that need it:
 *
 *   - `Observation` — one search per `category` (Epic refuses an
 *     un-categorised search). Defaults: `vital-signs`, `laboratory`.
 *   - `MedicationRequest` — Epic refuses an un-`status`-scoped search.
 *     Defaults: `active`. Multi-status fan-out (#1114) lets a med-rec
 *     tenant pull e.g. `active,on-hold,completed` in one sync.
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
 *   EPIC_MEDICATION_REQUEST_STATUS    — Comma-separated FHIR
 *     MedicationRequest status codes (e.g. `active,on-hold,completed`).
 *     A single value (e.g. `active`) is still accepted — that's the
 *     pre-#1114 shape and downstream tenants keep working without an
 *     env change. Same trim / dedup / unknown-drop semantics as
 *     `EPIC_OBSERVATION_CATEGORIES`. The `it.skip` placeholder from
 *     #1100 (tracked under #1105) is now a real test.
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

export const DEFAULT_MEDICATION_REQUEST_STATUSES: readonly string[] = [
  "active",
];

/**
 * Back-compat alias for the singular constant exported pre-#1114.
 * Equal to `DEFAULT_MEDICATION_REQUEST_STATUSES[0]`. New code should
 * use the plural constant.
 */
export const DEFAULT_MEDICATION_REQUEST_STATUS: string =
  DEFAULT_MEDICATION_REQUEST_STATUSES[0]!;

export interface FanoutConfig {
  readonly observationCategories: readonly string[];
  readonly medicationRequestStatuses: readonly string[];
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

/**
 * Parse + validate `EPIC_MEDICATION_REQUEST_STATUS` (#1114).
 *
 * Pre-#1114 this was a single-value env. The shape upgrade is fully
 * back-compat: a singleton like `EPIC_MEDICATION_REQUEST_STATUS=active`
 * still resolves to `["active"]`. Multi-value like
 * `EPIC_MEDICATION_REQUEST_STATUS=active,on-hold,completed` produces the
 * comma-split list. Trim, dedup, and unknown-code-drop semantics match
 * `parseObservationCategories` so a med-rec tenant gets the same UX as
 * the Observation fan-out (#1109).
 */
function parseMedicationRequestStatuses(
  raw: string | undefined,
): ParseResult<string[]> {
  if (raw === undefined) {
    return { value: [...DEFAULT_MEDICATION_REQUEST_STATUSES] };
  }

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
    if (VALID_MEDICATION_REQUEST_STATUSES.has(p)) valid.push(p);
    else invalid.push(p);
  }

  if (valid.length === 0) {
    // All-empty (`""`, `,,,`, `"   "`) or all-invalid → fall back.
    // Silently disabling MedicationRequest sync is worse than refusing
    // the misconfig; emit a warning so the operator sees their override
    // didn't take effect. The "not a known FHIR medication-request-status"
    // phrasing is shared with the partial-invalid path so callers can
    // grep one regex for the misconfig-class warning regardless of
    // whether they typoed one entry or all of them.
    return {
      value: [...DEFAULT_MEDICATION_REQUEST_STATUSES],
      warning: {
        msg:
          parts.length === 0
            ? "EPIC_MEDICATION_REQUEST_STATUS set but parsed empty, using default"
            : "EPIC_MEDICATION_REQUEST_STATUS contains values that are not a known FHIR medication-request-status code, using default",
        meta: {
          raw,
          invalidCodes: invalid,
          fallback: [...DEFAULT_MEDICATION_REQUEST_STATUSES],
        },
      },
    };
  }

  if (invalid.length > 0) {
    // Partial misconfig — keep the valid ones, warn about the typos.
    return {
      value: valid,
      warning: {
        msg: "EPIC_MEDICATION_REQUEST_STATUS contains unknown FHIR medication-request-status codes, dropping",
        meta: { raw, invalidCodes: invalid, kept: valid },
      },
    };
  }

  return { value: valid };
}

/** One structured warning emitted while parsing a fan-out env (#1116). */
export interface FanoutConfigWarning {
  msg: string;
  meta: Record<string, unknown>;
}

/** Result of `parseFanoutConfig` — config + warnings, no side effects (#1116). */
export interface ParsedFanoutConfig {
  config: FanoutConfig;
  warnings: FanoutConfigWarning[];
}

/**
 * Pure parse + validate (#1116) — no logger side effects. Useful for
 * admin / diagnostics tooling that wants to PREVIEW what a candidate
 * env override would produce (e.g. CLI `dry-run this
 * EPIC_OBSERVATION_CATEGORIES value`) without emitting the warnings
 * into the worker's real log.
 *
 * The boot path (`loadFanoutConfig`) is a thin wrapper that calls
 * this and forwards warnings to the module logger, so the production
 * behaviour is unchanged.
 */
export function parseFanoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): ParsedFanoutConfig {
  const cats = parseObservationCategories(env.EPIC_OBSERVATION_CATEGORIES);
  const statuses = parseMedicationRequestStatuses(
    env.EPIC_MEDICATION_REQUEST_STATUS,
  );
  const warnings: FanoutConfigWarning[] = [];
  if (cats.warning) warnings.push(cats.warning);
  if (statuses.warning) warnings.push(statuses.warning);
  return {
    config: {
      observationCategories: cats.value,
      medicationRequestStatuses: statuses.value,
    },
    warnings,
  };
}

/**
 * Parse + validate fan-out env AND emit warnings to the module logger.
 * Thin wrapper around `parseFanoutConfig` (#1116) — production boot
 * path. Admin tooling that wants pure-eval semantics should call
 * `parseFanoutConfig` directly.
 */
export function loadFanoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): FanoutConfig {
  const { config, warnings } = parseFanoutConfig(env);
  for (const w of warnings) log.warn(w.msg, w.meta);
  return config;
}

let cached: FanoutConfig | null = null;

/**
 * Returns the resolved fan-out config, loading + caching on first
 * access. Subsequent calls in the same process reuse the cached
 * value. The returned object and its arrays are frozen so a consumer
 * doing `getFanoutConfig().observationCategories.push(...)` can't
 * silently mutate the process-wide config and bypass validation.
 */
export function getFanoutConfig(): FanoutConfig {
  if (cached === null) {
    const fresh = loadFanoutConfig();
    cached = Object.freeze({
      observationCategories: Object.freeze([...fresh.observationCategories]),
      medicationRequestStatuses: Object.freeze([
        ...fresh.medicationRequestStatuses,
      ]),
    });
  }
  return cached;
}

/**
 * Clear the cached config — test-only. Production code should never
 * call this; env doesn't change after boot.
 */
export function resetFanoutConfigCacheForTests(): void {
  cached = null;
}

export function getObservationCategories(): readonly string[] {
  return getFanoutConfig().observationCategories;
}

/**
 * Plural getter — returns every status the sync worker should fan out
 * over for `MedicationRequest`. Default: `["active"]` (#1114).
 */
export function getMedicationRequestStatuses(): readonly string[] {
  return getFanoutConfig().medicationRequestStatuses;
}

/**
 * Singular getter — back-compat alias for the pre-#1114 API. Returns
 * the first element of {@link getMedicationRequestStatuses}. Retained
 * so downstream consumers that imported the singular name keep
 * compiling; new code should call the plural helper.
 */
export function getMedicationRequestStatus(): string {
  return getMedicationRequestStatuses()[0]!;
}
