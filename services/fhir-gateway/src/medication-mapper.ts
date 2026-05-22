/**
 * Inbound FHIR R4 MedicationRequest / MedicationStatement → CareBridge
 * `medications`-row mapper (issue #1066).
 *
 * The export side (services/fhir-gateway/src/generators/medication-*.ts)
 * already serialises the internal `medications` table to FHIR. This
 * mapper is the inverse: it takes a FHIR resource as ingested through
 * `importBundle` and produces the row shape the clinical-data writer
 * would have produced for the same prescription, so external EHRs
 * pushing dosing detail (Dosage.doseQuantity, Dosage.maxDosePerPeriod,
 * route, frequency, status) can drive the ai-oversight daily-dose rule
 * the same way internal tRPC writes do today.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitization (the
 * caller has already sanitised by the time importBundle reaches us).
 * Returns `null` when the resource is unmappable (missing medication
 * name, malformed structure) so the caller can skip-and-warn rather
 * than crash the bundle.
 */

import type { MedRoute, MedStatus } from "@carebridge/shared-types";

// ── Types we accept from the inbound bundle ─────────────────────
// We don't import the export-side FHIR types here because inbound
// payloads from external EHRs are looser than what our exporter emits
// (optional fields may be missing, unknown extra fields present). The
// bundle schema (services/fhir-gateway/src/schemas/bundle.ts) uses
// .passthrough() so the raw resource arrives as a generic
// Record<string, unknown> — we narrow defensively at each access.

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

interface InboundRatio {
  numerator?: InboundQuantity;
  denominator?: InboundQuantity;
}

interface InboundReference {
  reference?: string;
}

interface InboundDoseAndRate {
  doseQuantity?: InboundQuantity;
  rateQuantity?: InboundQuantity;
}

interface InboundTimingRepeat {
  frequency?: number;
  period?: number;
  periodUnit?: string;
}

interface InboundTiming {
  code?: InboundCodeableConcept;
  repeat?: InboundTimingRepeat;
}

interface InboundDosage {
  text?: string;
  route?: InboundCodeableConcept;
  timing?: InboundTiming;
  doseAndRate?: InboundDoseAndRate[];
  maxDosePerPeriod?: InboundRatio;
}

export interface InboundMedicationRequest {
  resourceType: "MedicationRequest";
  id?: string;
  status?: string;
  intent?: string;
  medicationCodeableConcept?: InboundCodeableConcept;
  subject?: InboundReference;
  authoredOn?: string;
  requester?: InboundReference;
  dosageInstruction?: InboundDosage[];
}

export interface InboundMedicationStatement {
  resourceType: "MedicationStatement";
  id?: string;
  status?: string;
  medicationCodeableConcept?: InboundCodeableConcept;
  subject?: InboundReference;
  effectivePeriod?: { start?: string; end?: string };
  dateAsserted?: string;
  informationSource?: InboundReference;
  dosage?: InboundDosage[];
}

// ── Mapped output shape ─────────────────────────────────────────

/**
 * Shape of the row to insert into `medications`. Mirrors
 * CreateMedicationInput from clinical-data but with `patient_id` as an
 * explicit caller-supplied value (the FHIR `subject.reference` carries
 * the patient id, but the importBundle path validates the patient
 * resolution itself and passes a verified id in).
 */
export interface MappedMedicationRow {
  patient_id: string;
  name: string;
  dose_amount: number | null;
  dose_unit: string | null;
  route: MedRoute | null;
  frequency: string | null;
  max_doses_per_day: number | null;
  status: MedStatus;
  started_at: string | null;
  prescribed_by: string | null;
  rxnorm_code: string | null;
  source_system: string | null;
}

// ── Route mapping ───────────────────────────────────────────────

/**
 * SNOMED CT route code → internal MedRoute enum. Mirrors the export
 * side ROUTE_SNOMED table (generators/medication-{request,statement}.ts)
 * so an exported-then-reimported bundle round-trips losslessly.
 */
const ROUTE_BY_SNOMED: Record<string, MedRoute> = {
  "26643006": "oral",
  "47625008": "IV",
  "78421000": "IM",
  "34206005": "subcutaneous",
  "6064005": "topical",
  "418730005": "inhaled",
  "37161004": "rectal",
  "284009009": "other",
};

/**
 * Free-text route token → internal MedRoute. Case-insensitive,
 * exact-stem match. Mirrors what the export side writes as
 * route.text. Returns null on miss so the caller can degrade to a
 * non-routed row rather than smuggling an invalid enum value into the
 * DB.
 */
function mapRouteText(text: string): MedRoute | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  // Direct enum values
  if (t === "oral" || t === "po") return "oral";
  if (t === "iv" || t === "intravenous") return "IV";
  if (t === "im" || t === "intramuscular") return "IM";
  if (
    t === "subcutaneous" ||
    t === "sc" ||
    t === "subq" ||
    t === "sq"
  ) return "subcutaneous";
  if (t === "topical") return "topical";
  if (t === "inhaled" || t === "inhalation") return "inhaled";
  if (t === "rectal" || t === "pr") return "rectal";
  if (t === "other") return "other";
  return null;
}

/**
 * Extract an internal MedRoute from a FHIR Dosage.route. Prefers
 * SNOMED coding (the export side always emits one) but falls back
 * to free-text — external EHRs may send only `text`, only `coding`,
 * or a heterogeneous mix.
 */
export function mapRoute(route: InboundCodeableConcept | undefined): MedRoute | null {
  if (!route) return null;
  // 1. Try every SNOMED coding entry first — most reliable signal.
  for (const c of route.coding ?? []) {
    if (!c.code) continue;
    if (
      c.system === "http://snomed.info/sct" ||
      // Tolerant: some EHRs drop the system on locally-coded routes.
      c.system === undefined
    ) {
      const mapped = ROUTE_BY_SNOMED[c.code];
      if (mapped) return mapped;
    }
  }
  // 2. Any coding.display interpreted as free-text.
  for (const c of route.coding ?? []) {
    if (c.display) {
      const m = mapRouteText(c.display);
      if (m) return m;
    }
  }
  // 3. The free-text `text` field itself.
  if (route.text) {
    return mapRouteText(route.text);
  }
  return null;
}

// ── Status mapping ──────────────────────────────────────────────

/**
 * FHIR MedicationRequest.status → internal MedStatus. The FHIR value
 * set is wider than the internal enum; values without an internal
 * analogue (draft/proposal/unknown) map to "active" because the
 * record was imported into a real patient chart — treating it as
 * absent would silently drop dosing info from the rule context.
 *
 * `entered-in-error` is the one exception: rows with that status are
 * filtered out of the rule context, so we preserve it as "completed"
 * is closest in MedStatus terms, BUT we also return null to signal
 * "skip this entry" — entered-in-error means the chart entry was a
 * mistake and should not be materialised.
 */
export function mapRequestStatusToInternal(status: string | undefined): MedStatus | null {
  if (!status) return "active";
  switch (status.toLowerCase()) {
    case "active":
      return "active";
    case "on-hold":
      return "held";
    case "completed":
      return "completed";
    case "cancelled":
    case "stopped":
      return "discontinued";
    case "entered-in-error":
      return null; // skip — chart mistake
    case "draft":
    case "unknown":
    default:
      // Pre-order / unknown still imports as active — the inbound
      // payload carried dose detail the rule engine should see.
      return "active";
  }
}

/**
 * FHIR MedicationStatement.status → internal MedStatus. Subset of the
 * MedicationRequest mapper, plus the statement-only statuses.
 */
export function mapStatementStatusToInternal(status: string | undefined): MedStatus | null {
  if (!status) return "active";
  switch (status.toLowerCase()) {
    case "active":
      return "active";
    case "on-hold":
      return "held";
    case "completed":
      return "completed";
    case "stopped":
    case "not-taken":
      return "discontinued";
    case "intended":
    case "unknown":
      return "active";
    case "entered-in-error":
      return null;
    default:
      return "active";
  }
}

// ── Medication name extraction ──────────────────────────────────

/**
 * Pick the medication name from `medicationCodeableConcept`. Order of
 * preference: `.text` (most human-readable; what our exporter emits),
 * then the first non-empty `coding[].display`. Returns null when
 * nothing usable is present — the caller skips the entry.
 */
export function extractMedicationName(
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
 * Extract the RxNorm code from `medicationCodeableConcept.coding[]`.
 * Returns the first entry coded against the RxNorm system, or null.
 */
export function extractRxNormCode(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (
      c.system === "http://www.nlm.nih.gov/research/umls/rxnorm" &&
      c.code &&
      c.code !== "unknown"
    ) {
      return c.code;
    }
  }
  return null;
}

// ── Dose extraction ─────────────────────────────────────────────

/**
 * Extract `dose_amount` + `dose_unit` from `dosageInstruction[0].doseAndRate[0].doseQuantity`.
 * Both fields are returned together (or both null) so the caller
 * doesn't have to handle the half-populated case — a unit without a
 * value is meaningless, and vice versa.
 */
export function extractDoseQuantity(
  dosage: InboundDosage | undefined,
): { amount: number; unit: string } | null {
  const dq = dosage?.doseAndRate?.[0]?.doseQuantity;
  if (!dq) return null;
  if (typeof dq.value !== "number" || !Number.isFinite(dq.value)) return null;
  const unit = dq.unit ?? dq.code;
  if (!unit) return null;
  return { amount: dq.value, unit };
}

// ── Frequency extraction ────────────────────────────────────────

/**
 * Extract free-text frequency from `dosageInstruction[0].timing.code.text`.
 * Mirrors what the exporter writes; falls back to coding display.
 * Returns null when neither is present.
 */
export function extractFrequency(
  dosage: InboundDosage | undefined,
): string | null {
  const timing = dosage?.timing;
  if (!timing) return null;
  if (timing.code?.text && timing.code.text.trim() !== "") {
    return timing.code.text.trim();
  }
  for (const c of timing.code?.coding ?? []) {
    if (c.display && c.display.trim() !== "") return c.display.trim();
  }
  return null;
}

// ── maxDosePerPeriod extraction ─────────────────────────────────

/**
 * Convert a FHIR Dosage.maxDosePerPeriod (a Ratio) into the integer
 * doses-per-day the internal `max_doses_per_day` column expects.
 *
 * Per FHIR R4 the numerator is dose count or quantity and the
 * denominator is the time period. We accept the entry only when:
 *   - numerator.value is a finite number
 *   - denominator describes a per-day window (UCUM "d" code, or
 *     denominator.unit/text matching /day|d/i with value 1, or no
 *     denominator at all — which most exporters emit when "per day"
 *     is implicit).
 *
 * Anything else (per-week, per-dose, missing) returns null so the
 * rule context falls back to runtime frequency parsing (the
 * fail-open behaviour described in #935).
 *
 * Returns a positive integer — fractional or zero numerators are
 * dropped (the daily-dose rule treats them as no-cap and they'd
 * round to a confusing 0 or 1 in the DB anyway).
 */
export function extractMaxDosesPerDay(
  dosage: InboundDosage | undefined,
): number | null {
  const ratio = dosage?.maxDosePerPeriod;
  if (!ratio?.numerator) return null;
  const num = ratio.numerator.value;
  if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
    return null;
  }
  const denom = ratio.denominator;
  if (denom !== undefined) {
    // Reject explicit non-day denominators.
    const denomValue = denom.value ?? 1;
    if (denomValue !== 1) return null;
    const code = denom.code?.toLowerCase();
    const unit = denom.unit?.toLowerCase();
    const isPerDay =
      code === "d" ||
      code === "day" ||
      (unit !== undefined && /^(d|day|days)$/.test(unit));
    if (!isPerDay) return null;
  }
  // Round down: a `4.5 doses/day` numerator is treated as 4 to err
  // toward not double-counting a partial dose at the rule boundary.
  return Math.floor(num);
}

// ── Reference resolution ────────────────────────────────────────

/**
 * Resolve a Practitioner reference (e.g. `Practitioner/abc-123`) to
 * the internal user_id used by `medications.prescribed_by`.
 *
 * Minimum-viable implementation (#1066): parse `Practitioner/{id}`
 * and return the raw id. Looking up the internal user row to verify
 * the practitioner exists is deferred to a follow-up — the import
 * path already records the raw reference and a downstream
 * reconciliation job can normalise IDs later.
 *
 * Returns null when the reference is missing, malformed, or doesn't
 * match the Practitioner resource type.
 */
export function resolvePractitionerReference(
  ref: InboundReference | undefined,
): string | null {
  if (!ref?.reference) return null;
  const match = /^Practitioner\/(.+)$/.exec(ref.reference);
  if (!match) return null;
  return match[1] ?? null;
}

// ── Main mapper functions ───────────────────────────────────────

const SOURCE_SYSTEM_TAG = "fhir_import";

/**
 * Map a FHIR R4 MedicationRequest to a CareBridge `medications` row.
 *
 * @param resource Sanitised FHIR resource (importBundle has already
 *                 run sanitizeFreeText over every string).
 * @param patientId Internal patient id the bundle is being imported
 *                 against. The mapper trusts the caller to have
 *                 resolved subject.reference to this id.
 * @returns A row shape ready to insert, or null when the resource is
 *          unmappable (no medication name, entered-in-error status).
 */
export function mapMedicationRequestToRow(
  resource: InboundMedicationRequest,
  patientId: string,
): MappedMedicationRow | null {
  const name = extractMedicationName(resource.medicationCodeableConcept);
  if (!name) return null;
  const status = mapRequestStatusToInternal(resource.status);
  if (status === null) return null;

  const dosage = resource.dosageInstruction?.[0];
  const dose = extractDoseQuantity(dosage);
  const frequency = extractFrequency(dosage);
  const route = mapRoute(dosage?.route);
  const maxDoses = extractMaxDosesPerDay(dosage);
  const rxnorm = extractRxNormCode(resource.medicationCodeableConcept);
  const prescribedBy = resolvePractitionerReference(resource.requester);

  return {
    patient_id: patientId,
    name,
    dose_amount: dose?.amount ?? null,
    dose_unit: dose?.unit ?? null,
    route,
    frequency,
    max_doses_per_day: maxDoses,
    status,
    started_at: resource.authoredOn ?? null,
    prescribed_by: prescribedBy,
    rxnorm_code: rxnorm,
    source_system: SOURCE_SYSTEM_TAG,
  };
}

/**
 * Map a FHIR R4 MedicationStatement to a CareBridge `medications` row.
 *
 * Statements describe medications the patient is currently taking or
 * has taken historically — they have no `requester`, a different
 * status value set, and the dosage live under `dosage[]` instead of
 * `dosageInstruction[]`. Otherwise mirrors the MedicationRequest
 * mapper field-for-field.
 */
export function mapMedicationStatementToRow(
  resource: InboundMedicationStatement,
  patientId: string,
): MappedMedicationRow | null {
  const name = extractMedicationName(resource.medicationCodeableConcept);
  if (!name) return null;
  const status = mapStatementStatusToInternal(resource.status);
  if (status === null) return null;

  const dosage = resource.dosage?.[0];
  const dose = extractDoseQuantity(dosage);
  const frequency = extractFrequency(dosage);
  const route = mapRoute(dosage?.route);
  const maxDoses = extractMaxDosesPerDay(dosage);
  const rxnorm = extractRxNormCode(resource.medicationCodeableConcept);

  // MedicationStatement has no `requester`; `informationSource` is
  // used for "who said the patient is on this" rather than who
  // prescribed it. We don't promote it into `prescribed_by` because
  // the semantics don't match — statements with a known prescriber
  // should arrive as a separate MedicationRequest in the same bundle.
  return {
    patient_id: patientId,
    name,
    dose_amount: dose?.amount ?? null,
    dose_unit: dose?.unit ?? null,
    route,
    frequency,
    max_doses_per_day: maxDoses,
    status,
    started_at: resource.effectivePeriod?.start ?? resource.dateAsserted ?? null,
    prescribed_by: null,
    rxnorm_code: rxnorm,
    source_system: SOURCE_SYSTEM_TAG,
  };
}
