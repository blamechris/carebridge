/**
 * Inbound FHIR R4 DiagnosticReport → CareBridge
 * `lab_panels` + child `lab_results` row mapper (issue #337).
 *
 * The export side (services/fhir-gateway/src/generators/observation.ts)
 * already serialises lab_results as individual FHIR Observation
 * resources. A DiagnosticReport groups those Observations into a panel
 * (CBC, BMP, lipids, ...). This mapper is the inverse: it takes a FHIR
 * DiagnosticReport — typically alongside the Observation resources it
 * references via `result[]` — and produces the (panel, results[]) row
 * pair that the clinical-data lab repo would have written for the same
 * data, so external EHRs pushing panel-grouped results can land in the
 * same shape that ai-oversight reads from.
 *
 * Option (a) implementation: when the caller can supply a lookup of the
 * Observation resources referenced by `DiagnosticReport.result[]`, the
 * mapper materialises a child `lab_results` row per referenced
 * Observation, linked back to the panel. When no observations are
 * supplied (or none of the refs resolve), the mapper still emits the
 * panel row with an empty `results` array — callers can treat that as
 * "panel imported, results to follow" without losing the parent record.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitisation (the
 * caller has already sanitised by the time importBundle reaches us).
 * Returns `null` when the panel itself is unmappable (no name,
 * `entered-in-error` status) so the caller can skip-and-warn.
 */

// ── Types we accept from the inbound bundle ─────────────────────
// Mirrors the medication-mapper pattern (#1066): inbound bundles use
// .passthrough() so resources arrive as a loose Record<string, unknown>.
// We narrow defensively at each access.

interface InboundCoding {
  system?: string;
  code?: string;
  display?: string;
}

interface InboundCodeableConcept {
  coding?: InboundCoding[];
  text?: string;
}

interface InboundQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

interface InboundReference {
  reference?: string;
}

interface InboundPeriod {
  start?: string;
  end?: string;
}

interface InboundReferenceRange {
  low?: InboundQuantity;
  high?: InboundQuantity;
}

export interface InboundObservation {
  resourceType: "Observation";
  id?: string;
  status?: string;
  category?: InboundCodeableConcept[];
  code?: InboundCodeableConcept;
  subject?: InboundReference;
  effectiveDateTime?: string;
  effectivePeriod?: InboundPeriod;
  issued?: string;
  valueQuantity?: InboundQuantity;
  interpretation?: InboundCodeableConcept[];
  referenceRange?: InboundReferenceRange[];
}

export interface InboundDiagnosticReport {
  resourceType: "DiagnosticReport";
  id?: string;
  status?: string;
  category?: InboundCodeableConcept[];
  code?: InboundCodeableConcept;
  subject?: InboundReference;
  effectiveDateTime?: string;
  effectivePeriod?: InboundPeriod;
  issued?: string;
  performer?: InboundReference[];
  resultsInterpreter?: InboundReference[];
  result?: InboundReference[];
}

// ── Mapped output shape ─────────────────────────────────────────

/**
 * Internal `lab_panels` row shape. Mirrors CreateLabPanelInput from
 * clinical-data, with `patient_id` as an explicit caller-supplied value
 * (the FHIR `subject.reference` may carry an external EHR's id; the
 * importBundle path is responsible for resolution).
 */
export interface LabPanelRow {
  patient_id: string;
  panel_name: string;
  panel_code: string | null;
  ordered_by: string | null;
  collected_at: string | null;
  reported_at: string | null;
  ordering_provider_id: string | null;
  source_system: string | null;
}

/**
 * Internal `lab_results` row shape, less `panel_id` and `id` which the
 * caller fills in once the parent panel row is persisted.
 */
export interface LabResultRow {
  test_name: string;
  test_code: string | null;
  value: number;
  unit: string;
  reference_low: number | null;
  reference_high: number | null;
  flag: "H" | "L" | "critical" | null;
}

/**
 * Combined mapper output: the panel row plus the materialised result
 * rows. An empty `results` array means "no child Observations were
 * supplied or none resolved" — the caller still persists the panel.
 */
export interface MappedDiagnosticReport {
  panel: LabPanelRow;
  results: LabResultRow[];
}

// ── Status mapping ──────────────────────────────────────────────

/**
 * FHIR DiagnosticReport.status → does this row materialise?
 *
 * Most DiagnosticReport status values represent a valid panel snapshot
 * that should be imported (`partial`, `preliminary`, `final`,
 * `amended`, `corrected`, `appended`, etc.). The exceptions are
 * `entered-in-error` (chart correction — must be dropped) and the
 * wildly out-of-domain `unknown`, which we still import as the
 * underlying data is meaningful even if administrative status isn't.
 *
 * Returns true to import, false to drop. Mirrors the
 * `mapRequestStatusToInternal → null` semantics in medication-mapper.
 */
export function shouldImportDiagnosticReport(status: string | undefined): boolean {
  if (!status) return true;
  return status.toLowerCase() !== "entered-in-error";
}

// ── LOINC / panel-code extraction ───────────────────────────────

const LOINC_SYSTEM = "http://loinc.org";

/**
 * Extract the panel display name from `code.text` (preferred — most
 * human-readable, what our exporter would emit) or fall back to the
 * first non-empty `coding[].display`. Returns null when nothing usable
 * is present.
 */
export function extractPanelName(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  if (cc.text && cc.text.trim() !== "") return cc.text.trim();
  for (const c of cc.coding ?? []) {
    if (c.display && c.display.trim() !== "") return c.display.trim();
  }
  return null;
}

/**
 * Extract the LOINC code for the panel from `code.coding[]`. Returns
 * the first entry coded against the LOINC system, or null when no
 * LOINC coding is present. We deliberately do not fall back to any
 * other coding system: a non-LOINC code in `panel_code` would mislead
 * the ai-oversight rule context, which keys off LOINC.
 */
export function extractPanelLoinc(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (c.system === LOINC_SYSTEM && c.code && c.code.trim() !== "") {
      return c.code;
    }
  }
  return null;
}

// ── Reference resolution ────────────────────────────────────────

/**
 * Resolve a Practitioner reference (`Practitioner/{id}`) to the raw
 * external id used by `lab_panels.ordered_by` /
 * `lab_panels.ordering_provider_id`. Mirrors
 * `resolvePractitionerReference` in medication-mapper — defers the
 * internal-user lookup to a reconciliation job downstream.
 */
export function resolvePractitionerReference(
  ref: InboundReference | undefined,
): string | null {
  if (!ref?.reference) return null;
  const match = /^Practitioner\/(.+)$/.exec(ref.reference);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Normalise a FHIR `result[]` reference to the canonical lookup key.
 * Inbound bundles may carry either a typed reference like
 * `Observation/obs-123` or a bundle-local pointer like
 * `urn:uuid:abc-...`. We return the trailing identifier so the caller
 * can look the resource up in a map keyed by either form.
 *
 * Returns null when the reference is empty or malformed.
 */
export function normaliseObservationReference(
  ref: InboundReference | undefined,
): string | null {
  if (!ref?.reference) return null;
  const r = ref.reference.trim();
  if (r === "") return null;
  const obsMatch = /^Observation\/(.+)$/.exec(r);
  if (obsMatch) return obsMatch[1] ?? null;
  const urnMatch = /^urn:uuid:(.+)$/.exec(r);
  if (urnMatch) return urnMatch[1] ?? null;
  // Bare id (e.g. just "obs-1") — accept as-is so a caller indexing
  // by raw resource.id can still match.
  return r;
}

// ── Lab Observation → lab_results row ───────────────────────────

/**
 * Map a single FHIR R4 Observation (lab category) into an internal
 * lab_results row. Returns null when the observation is unmappable:
 *   - status is entered-in-error (chart correction)
 *   - no test name (code.text and coding[].display both missing)
 *   - no numeric valueQuantity (we don't yet support string / coded
 *     results — those exit through a follow-up mapper)
 *   - no unit (a unitless value is meaningless for the rule engine)
 *
 * The flag column is populated when `interpretation[]` carries a
 * known V3 ObservationInterpretation code (H, L, A, AA) — mirroring
 * what the export side could in theory emit. Unrecognised
 * interpretations are dropped to null rather than smuggled into the
 * enum.
 */
export function mapLabObservationToResultRow(
  obs: InboundObservation,
): LabResultRow | null {
  if (obs.status && obs.status.toLowerCase() === "entered-in-error") {
    return null;
  }
  const testName = extractTestName(obs.code);
  if (!testName) return null;

  const q = obs.valueQuantity;
  if (!q || typeof q.value !== "number" || !Number.isFinite(q.value)) {
    return null;
  }
  const unit = q.unit ?? q.code;
  if (!unit || unit.trim() === "") return null;

  const testCode = extractLoincFromCoding(obs.code);
  const range = obs.referenceRange?.[0];
  const refLow = typeof range?.low?.value === "number" && Number.isFinite(range.low.value)
    ? range.low.value
    : null;
  const refHigh = typeof range?.high?.value === "number" && Number.isFinite(range.high.value)
    ? range.high.value
    : null;
  const flag = extractInterpretationFlag(obs.interpretation);

  return {
    test_name: testName,
    test_code: testCode,
    value: q.value,
    unit,
    reference_low: refLow,
    reference_high: refHigh,
    flag,
  };
}

function extractTestName(cc: InboundCodeableConcept | undefined): string | null {
  if (!cc) return null;
  if (cc.text && cc.text.trim() !== "") return cc.text.trim();
  for (const c of cc.coding ?? []) {
    if (c.display && c.display.trim() !== "") return c.display.trim();
  }
  return null;
}

function extractLoincFromCoding(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (c.system === LOINC_SYSTEM && c.code && c.code.trim() !== "") {
      return c.code;
    }
  }
  return null;
}

const INTERPRETATION_V3_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";

function extractInterpretationFlag(
  interps: InboundCodeableConcept[] | undefined,
): LabResultRow["flag"] {
  if (!interps) return null;
  for (const cc of interps) {
    for (const c of cc.coding ?? []) {
      // Accept V3 codes specifically; ignore other coding systems to
      // avoid a `text: "high"` rogue interpretation overriding the
      // structured flag column. Critical & abnormal map to "critical".
      if (
        c.system === INTERPRETATION_V3_SYSTEM ||
        c.system === undefined
      ) {
        const code = c.code?.toUpperCase();
        if (code === "H") return "H";
        if (code === "L") return "L";
        if (code === "HH" || code === "LL" || code === "AA") return "critical";
        if (code === "A") return null; // generic abnormal — no flag
      }
    }
    // Fall back to free text
    const text = cc.text?.toLowerCase();
    if (text === "high" || text === "h") return "H";
    if (text === "low" || text === "l") return "L";
    if (text === "critical" || text === "panic") return "critical";
  }
  return null;
}

// ── Main mapper ─────────────────────────────────────────────────

const SOURCE_SYSTEM_TAG = "fhir_import";

/**
 * Map a FHIR R4 DiagnosticReport to a CareBridge `lab_panels` row plus
 * the child `lab_results` rows for each referenced Observation that
 * the caller could resolve.
 *
 * @param resource Sanitised FHIR DiagnosticReport (importBundle has
 *                 already run sanitizeFreeText over every string).
 * @param patientId Internal patient id the bundle is being imported
 *                 against. Caller is responsible for resolving
 *                 subject.reference to an internal id.
 * @param containedObservations Optional lookup of Observation resources
 *                 keyed by either bare resource id or bundle-local
 *                 `urn:uuid:` value. When provided, every reference in
 *                 `result[]` is resolved and the matching observations
 *                 are materialised as child lab_results rows. When
 *                 absent or empty, the panel is still returned with
 *                 results: [] so the caller can persist the parent.
 * @returns Mapped (panel, results) pair, or null when the panel itself
 *          is unmappable (no name, entered-in-error).
 */
export function mapFhirDiagnosticReportToRow(
  resource: InboundDiagnosticReport,
  patientId: string,
  containedObservations?: Map<string, InboundObservation>,
): MappedDiagnosticReport | null {
  if (!shouldImportDiagnosticReport(resource.status)) return null;
  const panelName = extractPanelName(resource.code);
  if (!panelName) return null;

  const panelCode = extractPanelLoinc(resource.code);
  // FHIR R4: performer[] is who actually performed the work; we treat
  // the first Practitioner entry as the ordered_by signal (most
  // exporters write the ordering clinician here). resultsInterpreter
  // is a stronger ordering-provider signal when present.
  const orderingProvider =
    resolveFirstPractitioner(resource.resultsInterpreter) ??
    resolveFirstPractitioner(resource.performer);

  const collectedAt =
    resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? null;
  const reportedAt = resource.issued ?? null;

  const panel: LabPanelRow = {
    patient_id: patientId,
    panel_name: panelName,
    panel_code: panelCode,
    ordered_by: orderingProvider,
    collected_at: collectedAt,
    reported_at: reportedAt,
    ordering_provider_id: orderingProvider,
    source_system: SOURCE_SYSTEM_TAG,
  };

  const results: LabResultRow[] = [];
  if (containedObservations && containedObservations.size > 0) {
    for (const ref of resource.result ?? []) {
      const key = normaliseObservationReference(ref);
      if (!key) continue;
      const obs = containedObservations.get(key);
      if (!obs) continue;
      const row = mapLabObservationToResultRow(obs);
      if (row) results.push(row);
    }
  }

  return { panel, results };
}

function resolveFirstPractitioner(
  refs: InboundReference[] | undefined,
): string | null {
  for (const r of refs ?? []) {
    const id = resolvePractitionerReference(r);
    if (id) return id;
  }
  return null;
}

/**
 * Build the Observation lookup map the diagnostic-report mapper
 * expects from a list of bundle entries. Indexes each Observation by
 * its resource id and (if present) its bundle entry's fullUrl
 * (typically `urn:uuid:...`), so result[] references in either form
 * resolve correctly.
 *
 * Pure helper exposed for the importBundle wiring and tests; the
 * mapper itself accepts any caller-provided map.
 */
export function indexBundleObservations(
  entries: Array<{ fullUrl?: string; resource?: { resourceType?: string; id?: string } }>,
): Map<string, InboundObservation> {
  const map = new Map<string, InboundObservation>();
  for (const entry of entries) {
    const res = entry.resource;
    if (!res || res.resourceType !== "Observation") continue;
    const obs = res as unknown as InboundObservation;
    if (res.id) map.set(res.id, obs);
    if (entry.fullUrl) {
      const urn = /^urn:uuid:(.+)$/.exec(entry.fullUrl);
      if (urn && urn[1]) map.set(urn[1], obs);
      else map.set(entry.fullUrl, obs);
    }
  }
  return map;
}
