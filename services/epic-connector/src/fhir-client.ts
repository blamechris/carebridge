/**
 * Epic FHIR R4 client (#390).
 *
 * Thin typed wrapper over Epic's interconnect FHIR endpoints. Handles:
 *   - Bearer-token authentication via EpicTokenClient
 *   - Bundle parsing, including `link[relation=next]` pagination
 *   - 401 retry-once-after-invalidate (handles silent revocation)
 *   - 429 backoff that respects the Retry-After header
 *   - 5xx exponential backoff with a configurable retry budget
 *
 * The client intentionally returns raw FHIR R4 resources (typed as
 * `FhirResource`). Conversion to CareBridge row shapes lives in
 * `converters.ts`, layered on top of the existing fhir-gateway inbound
 * mappers so the FHIR-import path and Epic-sync path share normalisation
 * logic instead of diverging.
 */
import { createLogger } from "@carebridge/logger";
import { EpicTokenClient } from "./token-client.js";
import type { EpicConfig } from "./config.js";
import type {
  EpicSearchParams,
  FhirBundle,
  FhirBundleLink,
  FhirResource,
  OperationOutcome,
} from "./fhir-types.js";
import { operationOutcomeHasIssueCode } from "./fhir-types.js";

const log = createLogger("epic-fhir-client");

/**
 * Typed error thrown by the Epic FHIR client on non-2xx responses.
 *
 * Carries the parsed OperationOutcome alongside the original Error
 * message so downstream consumers can discriminate failure categories
 * structurally (preferred) rather than substring-matching the
 * message (fragile, see #1096).
 *
 * Epic error codes the connector currently reasons about:
 *
 *   "59022"  Combination of parameters is not valid for any authorized
 *            sub-resource. Used by sync-jobs.ts to soft-skip categories
 *            the registered app doesn't carry a scope for.
 *
 *   "59108"  A required element is missing (e.g. Observation without
 *            category or code). Indicates a request-shape bug, NOT
 *            a scope issue — must surface, not be swallowed.
 *
 * `body` keeps a truncated snippet (first 500 chars via {@link safeReadBody})
 * of the raw response text for diagnostic logging when the response wasn't
 * parseable as an OperationOutcome (e.g. Epic returned an HTML 502 page
 * from a fronting proxy). NOT the full payload — callers needing the
 * complete body must re-fetch.
 */
/**
 * Maximum bytes captured in `EpicFhirError.body` / surfaced from
 * `safeReadBody` / serialised by `operationOutcomeError` (#1126).
 * Keeps log lines + error dialogs bounded while preserving enough
 * context to identify the failure. The full payload is in worker
 * logs / DLQ for forensics.
 */
const MAX_BODY_SNIPPET_BYTES = 500;

export class EpicFhirError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
    /** Truncated body snippet (≤MAX_BODY_SNIPPET_BYTES chars). Do NOT assume full payload. */
    public readonly body: string,
    public readonly operationOutcome?: OperationOutcome,
  ) {
    super(message);
    this.name = "EpicFhirError";
  }

  /** Structured check: does any issue carry `details.coding[].code === code`? */
  hasIssueCode(code: string): boolean {
    return this.operationOutcome
      ? operationOutcomeHasIssueCode(this.operationOutcome, code)
      : false;
  }
}

/**
 * Promote a raw Epic response body to a typed OperationOutcome, or
 * return undefined if it doesn't pass our structural trust checks
 * (#1103, #1104). The trust boundary matters: downstream
 * `hasIssueCode()` calls iterate `issue[*].details.coding[*]` and
 * compare `code`; if we accept a half-shaped payload, those checks
 * either silently misreport or throw on iteration.
 *
 * Promotion requires ALL of:
 *   1. JSON parses to a plain object (not "string" / number / array / null)
 *   2. resourceType === "OperationOutcome"
 *   3. Array.isArray(issue)
 *   4. every issue.details.coding[*] has a `code` string
 *
 * If any check fails, return undefined and let the caller fall back
 * to the raw body string in the Error message.
 */
function tryParseOperationOutcome(
  body: string,
): OperationOutcome | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.resourceType !== "OperationOutcome") return undefined;
  if (!Array.isArray(candidate.issue)) return undefined;
  for (const issue of candidate.issue as Array<{ details?: { coding?: Array<{ code?: unknown }> } }>) {
    const coding = issue?.details?.coding;
    if (!coding) continue;
    if (!Array.isArray(coding)) return undefined;
    for (const c of coding) {
      if (typeof c?.code !== "string") return undefined;
    }
  }
  return parsed as OperationOutcome;
}

export interface EpicFhirClientOptions {
  /** Maximum retry attempts on transient (429/5xx) errors. Default: 3. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. Default: 500. */
  backoffBaseMs?: number;
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the sleep helper for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS = {
  maxRetries: 3,
  backoffBaseMs: 500,
} as const;

const SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resources the Epic sandbox supports today. Adding to this list does
 * not require a code change — `request()` takes an arbitrary path — but
 * the typed wrappers (`searchPatients`, `searchObservations`, …) are
 * driven from this union so unsupported resource types fail at
 * compile time.
 */
export type EpicResourceType =
  | "Patient"
  | "Observation"
  | "Condition"
  | "MedicationRequest"
  | "AllergyIntolerance"
  | "Encounter";

export class EpicFhirClient {
  private readonly opts: Required<
    Omit<EpicFhirClientOptions, "fetchImpl" | "sleep">
  > & { fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void> };

  constructor(
    private readonly config: EpicConfig,
    private readonly tokens: EpicTokenClient,
    options: EpicFhirClientOptions = {},
  ) {
    this.opts = {
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_OPTIONS.backoffBaseMs,
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? SLEEP,
    };
  }

  /**
   * Read a single resource by id. Returns the resource or throws if
   * the response is an OperationOutcome (404, 410, etc).
   */
  async read<T extends FhirResource = FhirResource>(
    resourceType: EpicResourceType,
    id: string,
  ): Promise<T> {
    const resource = await this.request<T | OperationOutcome>(
      `${resourceType}/${encodeURIComponent(id)}`,
    );
    if (resource.resourceType === "OperationOutcome") {
      // read() expects 200 OK on success; pass it explicitly so the
      // synthetic EpicFhirError reports a contextually accurate status
      // instead of the always-200 placeholder (#1123).
      throw operationOutcomeError(resource as OperationOutcome, 200, "OK");
    }
    return resource as T;
  }

  /**
   * Search for resources. Returns the first page as a Bundle — callers
   * who want every result should use `searchAll` which auto-paginates.
   */
  async search<T extends FhirResource = FhirResource>(
    resourceType: EpicResourceType,
    params: EpicSearchParams = {},
  ): Promise<FhirBundle<T>> {
    const path = `${resourceType}?${encodeSearchParams(params)}`;
    return this.request<FhirBundle<T>>(path);
  }

  /**
   * Async iterator over every matching resource across all pages.
   * Walks `Bundle.link` with relation=next until exhausted. Yields
   * resources lazily so large result sets don't blow up memory.
   */
  async *searchAll<T extends FhirResource = FhirResource>(
    resourceType: EpicResourceType,
    params: EpicSearchParams = {},
  ): AsyncIterable<T> {
    let bundle: FhirBundle<T> | null = await this.search<T>(
      resourceType,
      params,
    );
    while (bundle !== null) {
      for (const entry of bundle.entry ?? []) {
        if (entry.resource) yield entry.resource;
      }
      const links: FhirBundleLink[] = bundle.link ?? [];
      const next = links.find((l) => l.relation === "next");
      if (!next) {
        bundle = null;
        break;
      }
      bundle = await this.request<FhirBundle<T>>(next.url);
    }
  }

  /**
   * Low-level request — used by read/search above. Exposed for callers
   * that need to hit endpoints we don't have typed wrappers for
   * (e.g. `/metadata`, `$lastn`). Takes either a relative path or an
   * absolute URL (Bundle.link.url returns absolute URLs).
   */
  async request<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : joinUrl(this.config.fhirBaseUrl, pathOrUrl);

    return this.requestWithRetry<T>(
      { url, method: "GET" },
      /* didRefreshAuth */ false,
      0,
    );
  }

  /**
   * POST a new FHIR resource to Epic. Used by the outbound flag-push
   * worker (#393) and any other write surface. The returned resource
   * is what Epic stored — typically the same payload echoed back with
   * `id` and `meta.versionId` populated.
   */
  async createResource<TBody extends FhirResource, TResp = TBody>(
    resourceType: EpicResourceType | "Flag",
    body: TBody,
  ): Promise<TResp> {
    const url = joinUrl(this.config.fhirBaseUrl, resourceType);
    const resp = await this.requestWithRetry<TResp | OperationOutcome>(
      {
        url,
        method: "POST",
        contentType: "application/fhir+json",
        body: JSON.stringify(body),
      },
      false,
      0,
    );
    if (
      typeof resp === "object" &&
      resp !== null &&
      (resp as { resourceType?: string }).resourceType === "OperationOutcome"
    ) {
      // POST resource creation typically returns 201 Created on success
      // — report that on the synthetic error instead of the 200 default
      // so log/dashboard consumers see honest status data (#1123).
      throw operationOutcomeError(resp as OperationOutcome, 201, "Created");
    }
    return resp as TResp;
  }

  /**
   * PUT an existing FHIR resource on Epic (update by id). The resource
   * body MUST carry `id` matching the URL path or Epic rejects.
   */
  async updateResource<TBody extends FhirResource, TResp = TBody>(
    resourceType: EpicResourceType | "Flag",
    id: string,
    body: TBody,
  ): Promise<TResp> {
    const url = joinUrl(
      this.config.fhirBaseUrl,
      `${resourceType}/${encodeURIComponent(id)}`,
    );
    const resp = await this.requestWithRetry<TResp | OperationOutcome>(
      {
        url,
        method: "PUT",
        contentType: "application/fhir+json",
        body: JSON.stringify(body),
      },
      false,
      0,
    );
    if (
      typeof resp === "object" &&
      resp !== null &&
      (resp as { resourceType?: string }).resourceType === "OperationOutcome"
    ) {
      // PUT typically returns 200 OK on success (some Epic deployments
      // return 201 Created when the put creates a new resource). Use
      // 200 as the per-call default; full plumb of the real wire
      // status lives in #1123.
      throw operationOutcomeError(resp as OperationOutcome, 200, "OK");
    }
    return resp as TResp;
  }

  private async requestWithRetry<T>(
    args: {
      url: string;
      method: "GET" | "POST" | "PUT" | "DELETE";
      contentType?: string;
      body?: string;
    },
    didRefreshAuth: boolean,
    attempt: number,
  ): Promise<T> {
    const token = await this.tokens.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/fhir+json",
    };
    if (args.contentType) headers["Content-Type"] = args.contentType;

    const response = await this.opts.fetchImpl(args.url, {
      method: args.method,
      headers,
      ...(args.body !== undefined ? { body: args.body } : {}),
    });

    if (response.status === 401 && !didRefreshAuth) {
      // Token revoked / org rotated keys: drop the cache and try once
      // with a fresh assertion. If it 401s again we surface the error
      // to the caller — repeated 401s mean credentials are misregistered
      // and retrying just hammers Epic's token endpoint.
      log.warn("Epic returned 401 — invalidating token and retrying once", {
        url: args.url,
      });
      this.tokens.invalidate();
      return this.requestWithRetry<T>(args, true, attempt);
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= this.opts.maxRetries) {
        const body = await safeReadBody(response);
        throw new EpicFhirError(
          `Epic FHIR request failed after ${attempt + 1} attempts: ` +
            `${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
          response.status,
          response.statusText,
          body,
          tryParseOperationOutcome(body),
        );
      }
      const delay = backoffDelay({
        status: response.status,
        attempt,
        retryAfter: response.headers.get("Retry-After"),
        baseMs: this.opts.backoffBaseMs,
      });
      log.warn("Epic FHIR transient error, retrying", {
        status: response.status,
        attempt,
        delayMs: delay,
      });
      await this.opts.sleep(delay);
      return this.requestWithRetry<T>(args, didRefreshAuth, attempt + 1);
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new EpicFhirError(
        `Epic FHIR request returned ${response.status} ${response.statusText}` +
          (body ? ` — ${body}` : ""),
        response.status,
        response.statusText,
        body,
        tryParseOperationOutcome(body),
      );
    }

    // 204 No Content (rare for FHIR but possible on PUT with Prefer: minimal)
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // ─────────────────────── Typed wrappers ────────────────────────
  // Thin sugar over `read`/`search` so callers don't have to remember
  // Epic's search-param names. Each method documents the params Epic
  // actually accepts for that resource (the full FHIR R4 search-param
  // surface is large; Epic supports a curated subset).

  readPatient(id: string): Promise<FhirResource> {
    return this.read("Patient", id);
  }

  /**
   * Search for a Patient by MRN or other identifier.
   * Epic search-param: `identifier=<system>|<value>` or just `<value>`.
   */
  searchPatients(params: {
    identifier?: string;
    family?: string;
    given?: string;
    birthdate?: string;
  }): Promise<FhirBundle> {
    return this.search("Patient", params);
  }

  /**
   * Search for Observations for a patient.
   * Epic supports: `patient`, `category` (vital-signs|laboratory),
   * `code`, `_lastUpdated` (use `gt2024-01-01` form for incremental).
   */
  searchObservations(params: {
    patient: string;
    category?: "vital-signs" | "laboratory";
    code?: string;
    _lastUpdated?: string;
    _count?: number;
  }): Promise<FhirBundle> {
    return this.search("Observation", params);
  }

  /**
   * Search for Conditions for a patient. Defaults to active.
   * Epic supports: `patient`, `clinical-status` (active|inactive|resolved),
   * `category` (problem-list-item|encounter-diagnosis).
   */
  searchConditions(params: {
    patient: string;
    "clinical-status"?: "active" | "inactive" | "resolved";
    category?: string;
  }): Promise<FhirBundle> {
    return this.search("Condition", params);
  }

  /**
   * Search for MedicationRequests for a patient.
   * Epic supports: `patient`, `status` (active|on-hold|completed|stopped),
   * `_lastUpdated`.
   */
  searchMedicationRequests(params: {
    patient: string;
    status?: "active" | "on-hold" | "completed" | "stopped" | "cancelled";
    _lastUpdated?: string;
  }): Promise<FhirBundle> {
    return this.search("MedicationRequest", params);
  }

  /**
   * Search for AllergyIntolerances for a patient.
   * Epic supports: `patient`, `clinical-status` (active|inactive|resolved).
   */
  searchAllergies(params: {
    patient: string;
    "clinical-status"?: "active" | "inactive" | "resolved";
  }): Promise<FhirBundle> {
    return this.search("AllergyIntolerance", params);
  }

  /**
   * Search for Encounters for a patient.
   * Epic supports: `patient`, `_lastUpdated`, `_sort=-date` for most-recent-first.
   */
  searchEncounters(params: {
    patient: string;
    _lastUpdated?: string;
    _sort?: "-date" | "date";
    _count?: number;
  }): Promise<FhirBundle> {
    return this.search("Encounter", params);
  }
}

// ───────────────────────── Helpers ─────────────────────────────

function encodeSearchParams(params: EpicSearchParams): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.append(key, String(value));
    }
  }
  return qs.toString();
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${trimmedBase}${trimmedPath}`;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_BODY_SNIPPET_BYTES);
  } catch {
    return "";
  }
}

/**
 * Build an EpicFhirError from an OperationOutcome returned in a 2xx
 * response body (#1101). FHIR allows servers to indicate semantic
 * failure on a successful HTTP status by returning an OperationOutcome
 * instead of the requested resource — Epic does this for /Patient/[id]
 * on a deleted patient, certain create/update edge cases, etc.
 * Returning EpicFhirError (not a plain Error) means downstream
 * `err.hasIssueCode("59022")` works for the 2xx-with-OO case the same
 * way it works for the 4xx-with-OO case.
 *
 * Status/statusText are the OPERATION'S expected success codes
 * (200 OK for read/update, 201 Created for create) — passed by the
 * caller because `requestWithRetry` discards the underlying Response
 * after parsing. A full plumb of the real wire status lives in
 * #1123; the per-caller default is honest about operation context
 * (read → 200, create → 201) and removes the "always 200" misreport.
 */
function operationOutcomeError(
  outcome: OperationOutcome,
  status: number,
  statusText: string,
): EpicFhirError {
  const issue = outcome.issue?.[0];
  const detail =
    issue?.diagnostics ?? issue?.details?.text ?? "no diagnostics";
  const message = `Epic returned OperationOutcome: ${issue?.code ?? "unknown"} — ${detail}`;
  return new EpicFhirError(
    message,
    status,
    statusText,
    JSON.stringify(outcome).slice(0, MAX_BODY_SNIPPET_BYTES),
    outcome,
  );
}

/**
 * Exponential backoff with a Retry-After override.
 *
 * Retry-After values come in two flavours per RFC 7231:
 *   - delta-seconds   (e.g. "30")     → use directly
 *   - HTTP-date       (e.g. RFC1123)  → compute the delta to now
 * Epic's sandbox emits delta-seconds; we accept either for robustness.
 *
 * Without Retry-After: delay = base * 2^attempt + 0..base jitter.
 * Jitter keeps multiple concurrent clients from thundering-herding the
 * same retry window.
 */
function backoffDelay(args: {
  status: number;
  attempt: number;
  retryAfter: string | null;
  baseMs: number;
}): number {
  if (args.retryAfter) {
    const seconds = Number(args.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(args.retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const expBackoff = args.baseMs * Math.pow(2, args.attempt);
  const jitter = Math.random() * args.baseMs;
  return expBackoff + jitter;
}
