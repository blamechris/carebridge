/**
 * Inbound FHIR R4 Observation → CareBridge row mapper (issue #337).
 *
 * Unlike MedicationRequest/Statement, a single FHIR Observation resource
 * type fans out to TWO internal tables based on
 * Observation.category[].coding[].code:
 *
 *   - "vital-signs" → `vitals`         (mapFhirObservationToVitalRow)
 *   - "laboratory"  → `lab_results`    (mapFhirObservationToLabResultRow)
 *
 * The caller (importBundle in router.ts) first calls
 * `classifyObservationCategory` to decide which target table the entry
 * routes to, then invokes the matching row mapper. Both mappers return
 * `null` when the resource is unmappable (missing LOINC, missing value,
 * status: entered-in-error) so the caller can skip-and-continue rather
 * than crash the bundle.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitisation (the
 * caller has already sanitised by the time importBundle reaches us).
 */

import { VITAL_LOINC_CODES, type VitalType, type LabFlag } from "@carebridge/shared-types";

// ── Types we accept from the inbound bundle ─────────────────────
// The bundle schema (services/fhir-gateway/src/schemas/bundle.ts) uses
// .passthrough() so resources arrive as generic objects. We narrow
// defensively at each access; unknown extra fields are ignored.

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

interface InboundObservationComponent {
  code?: InboundCodeableConcept;
  valueQuantity?: InboundQuantity;
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
  effectivePeriod?: { start?: string; end?: string };
  valueQuantity?: InboundQuantity;
  component?: InboundObservationComponent[];
  referenceRange?: InboundReferenceRange[];
  interpretation?: InboundCodeableConcept[];
}

// ── Mapped output shapes ───────────────────────────────────────

/**
 * Shape of the row to insert into `vitals`. Mirrors CreateVitalInput
 * from clinical-data; the caller supplies `patient_id` from the verified
 * import context (Observation.subject may reference an external EHR's
 * patient id, which is NOT the internal patients.id).
 */
export interface MappedVitalRow {
  patient_id: string;
  type: VitalType;
  loinc_code: string | null;
  value_primary: number;
  value_secondary: number | null;
  unit: string;
  recorded_at: string;
  source_system: string | null;
}

/**
 * Shape of the row to insert into `lab_results`. The `panel_id` column
 * is mandatory at the schema level but is supplied by the caller (the
 * importBundle path creates a synthetic lab_panels row per Observation,
 * or batches multiple results under one panel — that orchestration lives
 * in the router, not here).
 *
 * `recorded_at` is carried explicitly so the caller can decide whether
 * to write it into `lab_panels.collected_at` (canonical) or use it as
 * `lab_results.created_at` directly.
 */
export interface MappedLabResultRow {
  test_name: string;
  test_code: string | null;
  value: number;
  unit: string;
  reference_low: number | null;
  reference_high: number | null;
  flag: LabFlag | null;
  recorded_at: string;
}

// ── Category classification ────────────────────────────────────

const OBSERVATION_CATEGORY_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/observation-category";

export type ObservationCategory = "vital-signs" | "laboratory";

/**
 * Read Observation.category[].coding[] and return the first recognised
 * routing code. Tolerant of missing `system` (some EHRs locally-code the
 * category without the URL); strict on the `code` enum. Returns null
 * when no category — or no recognised category — is present, leaving
 * the routing decision (drop / fail-open / default) to the caller.
 *
 * If multiple categories are listed (e.g. ["exam", "vital-signs"]), the
 * first recognised one wins. vital-signs and laboratory are mutually
 * exclusive in practice so the iteration order doesn't matter.
 */
export function classifyObservationCategory(
  resource: InboundObservation,
): ObservationCategory | null {
  const cats = resource.category;
  if (!cats || cats.length === 0) return null;
  for (const cat of cats) {
    for (const c of cat.coding ?? []) {
      if (!c.code) continue;
      // Accept either the canonical observation-category system or no
      // system at all. Reject other systems to avoid collisions with
      // unrelated terminologies that happen to use the same codes.
      if (
        c.system !== undefined &&
        c.system !== OBSERVATION_CATEGORY_SYSTEM
      ) {
        continue;
      }
      if (c.code === "vital-signs") return "vital-signs";
      if (c.code === "laboratory") return "laboratory";
    }
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────

const LOINC_SYSTEM = "http://loinc.org";
const SOURCE_SYSTEM_TAG = "fhir_import";

/**
 * Pull the first LOINC-coded entry out of Observation.code.coding[].
 * Returns null when no LOINC entry is present — the caller falls back
 * to free-text test name (lab) or rejects the row (vitals).
 */
export function extractLoincCode(
  resource: Pick<InboundObservation, "code">,
): string | null {
  const code = resource.code;
  if (!code) return null;
  for (const c of code.coding ?? []) {
    if (c.system === LOINC_SYSTEM && c.code) {
      return c.code;
    }
  }
  return null;
}

/**
 * Extract value + unit from valueQuantity. unit prefers `.unit` and
 * falls back to `.code`; one-of-them missing makes the entry
 * unmappable (a unit without a value is meaningless and vice versa).
 */
export function extractValueQuantity(
  resource: Pick<InboundObservation, "valueQuantity">,
): { value: number; unit: string } | null {
  const q = resource.valueQuantity;
  if (!q) return null;
  if (typeof q.value !== "number" || !Number.isFinite(q.value)) return null;
  const unit = q.unit ?? q.code;
  if (!unit) return null;
  return { value: q.value, unit };
}

/**
 * Extract the effective time the observation pertains to. Prefers
 * `effectiveDateTime` (the most common form) and falls back to
 * `effectivePeriod.start` (used by some EHRs for continuously-monitored
 * vitals). Returns null when neither is present — vitals without a
 * timestamp are rejected because the rule engine indexes by time.
 */
export function extractEffectiveTime(
  resource: InboundObservation,
): string | null {
  if (resource.effectiveDateTime) return resource.effectiveDateTime;
  if (resource.effectivePeriod?.start) return resource.effectivePeriod.start;
  return null;
}

// ── LOINC → VitalType resolution ───────────────────────────────

/**
 * Inverse of VITAL_LOINC_CODES. Built once at module load — VitalType
 * is a closed enum and the LOINC code → type direction has no
 * ambiguity (each vital type uses a single LOINC code).
 *
 * For blood pressure, the panel LOINC (85354-9) maps to blood_pressure;
 * the component codes 8480-6 (systolic) and 8462-4 (diastolic) are
 * handled inline by mapFhirObservationToVitalRow.
 */
const LOINC_TO_VITAL_TYPE: Record<string, VitalType> = Object.fromEntries(
  (Object.entries(VITAL_LOINC_CODES) as Array<[VitalType, string | null]>)
    .filter((entry): entry is [VitalType, string] => entry[1] !== null)
    .map(([k, v]) => [v, k]),
);

const SYSTOLIC_BP_LOINC = "8480-6";
const DIASTOLIC_BP_LOINC = "8462-4";

/**
 * Extract systolic + diastolic from Observation.component[]. Returns
 * `null` when both components aren't present — a BP Observation
 * missing either half is incomplete and rejected.
 */
function extractBloodPressureComponents(
  resource: InboundObservation,
): { systolic: number; diastolic: number; unit: string } | null {
  const components = resource.component;
  if (!components || components.length === 0) return null;
  let systolic: { value: number; unit: string } | null = null;
  let diastolic: { value: number; unit: string } | null = null;
  for (const comp of components) {
    const loinc = extractLoincCode({ code: comp.code });
    if (!loinc) continue;
    const value = extractValueQuantity({ valueQuantity: comp.valueQuantity });
    if (!value) continue;
    if (loinc === SYSTOLIC_BP_LOINC) systolic = value;
    else if (loinc === DIASTOLIC_BP_LOINC) diastolic = value;
  }
  if (!systolic || !diastolic) return null;
  // Both halves share the same UCUM unit in practice (mmHg/mm[Hg]);
  // we pick systolic's unit as the canonical value since the parent
  // `vitals.unit` column carries one string.
  return {
    systolic: systolic.value,
    diastolic: diastolic.value,
    unit: systolic.unit,
  };
}

// ── Interpretation flag mapping ────────────────────────────────

/**
 * FHIR v3 ObservationInterpretation code → internal LabFlag. The full
 * value set is large; we accept only the common subset clinical-data's
 * `lab_results.flag` column carries today.
 */
function mapInterpretationFlag(
  interpretations: InboundCodeableConcept[] | undefined,
): LabFlag | null {
  if (!interpretations) return null;
  for (const i of interpretations) {
    for (const c of i.coding ?? []) {
      const code = c.code?.toUpperCase();
      if (!code) continue;
      // Critical first — overrides plain H/L when both are present.
      if (code === "HH" || code === "LL" || code === "AA") return "critical";
      if (code === "H" || code === ">") return "H";
      if (code === "L" || code === "<") return "L";
    }
  }
  return null;
}

// ── Main mappers ───────────────────────────────────────────────

/**
 * Map a FHIR R4 Observation (category=vital-signs) to a CareBridge
 * `vitals` row.
 *
 * @param resource Sanitised FHIR Observation. The caller is expected to
 *                 have already classified the category via
 *                 classifyObservationCategory and verified it equals
 *                 "vital-signs"; this function does NOT re-check
 *                 category to keep the logic single-responsibility.
 * @param patientId Internal patient id the bundle is being imported
 *                 against. Trusted from the caller's resolution of
 *                 subject.reference.
 * @returns A row shape ready to insert, or null when the resource is
 *          unmappable (no LOINC → VitalType match, missing value,
 *          missing effective time, entered-in-error status).
 */
export function mapFhirObservationToVitalRow(
  resource: InboundObservation,
  patientId: string,
): MappedVitalRow | null {
  if (resource.status === "entered-in-error") return null;
  const recordedAt = extractEffectiveTime(resource);
  if (!recordedAt) return null;

  const loinc = extractLoincCode(resource);
  if (!loinc) return null;

  const vitalType = LOINC_TO_VITAL_TYPE[loinc];
  if (!vitalType) return null;

  if (vitalType === "blood_pressure") {
    const bp = extractBloodPressureComponents(resource);
    if (!bp) return null;
    return {
      patient_id: patientId,
      type: "blood_pressure",
      loinc_code: loinc,
      value_primary: bp.systolic,
      value_secondary: bp.diastolic,
      unit: bp.unit,
      recorded_at: recordedAt,
      source_system: SOURCE_SYSTEM_TAG,
    };
  }

  const value = extractValueQuantity(resource);
  if (!value) return null;

  return {
    patient_id: patientId,
    type: vitalType,
    loinc_code: loinc,
    value_primary: value.value,
    value_secondary: null,
    unit: value.unit,
    recorded_at: recordedAt,
    source_system: SOURCE_SYSTEM_TAG,
  };
}

/**
 * Map a FHIR R4 Observation (category=laboratory) to a CareBridge
 * `lab_results` row shape.
 *
 * Note the returned shape carries `recorded_at` rather than the
 * panel/created_at split — the caller (importBundle) is responsible for
 * constructing the synthetic `lab_panels` row that anchors the result
 * via `panel_id`. We don't generate panel rows here because the same
 * Observation could be batched with peers under one synthetic panel
 * (e.g. a CBC bundle), and that batching decision belongs in the router.
 *
 * @param resource Sanitised FHIR Observation. The caller is expected to
 *                 have already classified the category as "laboratory".
 * @returns A row shape ready for the caller to attach a panel_id +
 *          id + created_at to, or null when unmappable.
 */
export function mapFhirObservationToLabResultRow(
  resource: InboundObservation,
): MappedLabResultRow | null {
  if (resource.status === "entered-in-error") return null;
  const recordedAt = extractEffectiveTime(resource);
  if (!recordedAt) return null;

  const value = extractValueQuantity(resource);
  if (!value) return null;

  // Prefer LOINC code; test_name prefers code.text, then the LOINC
  // entry's display, then the first non-empty coding.display.
  const loinc = extractLoincCode(resource);
  const testName = extractLabTestName(resource);
  if (!testName) return null;

  const range = resource.referenceRange?.[0];
  const refLow =
    typeof range?.low?.value === "number" && Number.isFinite(range.low.value)
      ? range.low.value
      : null;
  const refHigh =
    typeof range?.high?.value === "number" && Number.isFinite(range.high.value)
      ? range.high.value
      : null;

  const flag = mapInterpretationFlag(resource.interpretation);

  return {
    test_name: testName,
    test_code: loinc,
    value: value.value,
    unit: value.unit,
    reference_low: refLow,
    reference_high: refHigh,
    flag,
    recorded_at: recordedAt,
  };
}

/**
 * Pick a human-readable lab test name from Observation.code. Order of
 * preference mirrors extractMedicationName: `.text` first, then any
 * non-empty coding.display. Returns null when nothing usable is
 * present — without a name the result has no key for trending / lookup.
 */
function extractLabTestName(
  resource: Pick<InboundObservation, "code">,
): string | null {
  const cc = resource.code;
  if (!cc) return null;
  if (cc.text && cc.text.trim() !== "") return cc.text.trim();
  for (const c of cc.coding ?? []) {
    if (c.display && c.display.trim() !== "") return c.display.trim();
  }
  return null;
}
