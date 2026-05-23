/**
 * Minimal FHIR R4 type shapes used by the Epic FHIR client (#390).
 *
 * Intentionally narrow — we type-only the fields we actually read from
 * the wire and downcast everything else to `unknown`. The full FHIR R4
 * surface lives in `services/fhir-gateway/src/types/fhir-r4.ts`, but
 * pulling it in here would force epic-connector to depend on the entire
 * fhir-gateway runtime. Callers who need the full resource shape can
 * pass the returned `FhirResource` through to the fhir-gateway mappers.
 */

export interface FhirBundleEntry<TResource = FhirResource> {
  fullUrl?: string;
  resource?: TResource;
  search?: { mode?: "match" | "include" | "outcome" };
}

export interface FhirBundleLink {
  relation: string;
  url: string;
}

export interface FhirBundle<TResource = FhirResource> {
  resourceType: "Bundle";
  type: "searchset" | "history" | "transaction" | "batch" | string;
  total?: number;
  link?: FhirBundleLink[];
  entry?: FhirBundleEntry<TResource>[];
}

/**
 * Opaque resource record — Epic returns arbitrary FHIR R4 resources and
 * extensions. Strongly-typed shapes (FhirPatient, FhirObservation, …)
 * are produced by the fhir-gateway generators on the outbound side; we
 * keep inbound loose because Epic's payloads are looser than ours.
 */
export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    profile?: string[];
  };
  [k: string]: unknown;
}

/**
 * FHIR `OperationOutcome` shape — Epic returns these instead of a
 * resource Bundle when a request fails. We surface the `diagnostics`
 * field in thrown error messages for debugging.
 */
export interface OperationOutcome {
  resourceType: "OperationOutcome";
  issue: Array<{
    severity: "fatal" | "error" | "warning" | "information";
    code: string;
    diagnostics?: string;
    details?: { text?: string };
  }>;
}

export type EpicSearchParams = Record<
  string,
  string | number | undefined | string[]
>;
