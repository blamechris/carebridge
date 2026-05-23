/**
 * Inbound FHIR R4 Condition → CareBridge `diagnoses`-row mapper (#337).
 *
 * The export side (services/fhir-gateway/src/generators/condition.ts)
 * already serialises the internal `diagnoses` table to FHIR. This
 * mapper is the inverse: it takes a FHIR Condition resource ingested
 * through `importBundle` and produces the row shape the patient-records
 * writer would have produced for the same diagnosis, so external EHRs
 * pushing condition lists (ICD-10/SNOMED codes, clinical status,
 * onset/recorded dates) drive the ai-oversight cross-specialty rules
 * the same way internal tRPC writes do today.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitisation (the
 * caller has already sanitised by the time importBundle reaches us).
 * Returns `null` when the resource is unmappable (missing code,
 * verificationStatus=entered-in-error) so the caller can skip-and-warn
 * rather than crash the bundle.
 */

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

interface InboundReference {
  reference?: string;
}

interface InboundPeriod {
  start?: string;
  end?: string;
}

export interface InboundCondition {
  resourceType: "Condition";
  id?: string;
  clinicalStatus?: InboundCodeableConcept;
  verificationStatus?: InboundCodeableConcept;
  code?: InboundCodeableConcept;
  subject?: InboundReference;
  onsetDateTime?: string;
  onsetPeriod?: InboundPeriod;
  abatementDateTime?: string;
  recordedDate?: string;
  recorder?: InboundReference;
  severity?: InboundCodeableConcept;
}

// ── Mapped output shape ─────────────────────────────────────────

/**
 * Internal `diagnoses` status enum (active | resolved | chronic).
 * Mirrors `diagnosisStatusSchema` in packages/shared-types.
 */
export type DiagnosisStatus = "active" | "resolved" | "chronic";

/**
 * Internal severity enum returned by the mapper. The `diagnoses` table
 * itself does not currently store severity, but external EHRs
 * frequently send it on the Condition resource. The field is extracted
 * so callers (and a future schema migration) can surface it without a
 * second pass over the bundle.
 */
export type DiagnosisSeverity = "mild" | "moderate" | "severe";

/**
 * Shape of the row to insert into `diagnoses`. Mirrors the columns of
 * the `diagnoses` table plus the auxiliary `severity` field described
 * above. `patient_id` is supplied by the caller (importBundle has
 * already reconciled FHIR `subject.reference` to the internal id).
 *
 * `recorded_at` is exposed separately from a wall-clock `created_at`
 * so callers preserving external provenance can honour the EHR's
 * recordedDate when persisting; for the canonical `diagnoses.created_at`
 * insert, the caller picks `row.recorded_at ?? now`.
 */
export interface MappedDiagnosisRow {
  patient_id: string;
  description: string;
  icd10_code: string | null;
  snomed_code: string | null;
  status: DiagnosisStatus;
  onset_date: string | null;
  resolved_date: string | null;
  diagnosed_by: string | null;
  severity: DiagnosisSeverity | null;
  recorded_at: string | null;
}

// ── System constants ────────────────────────────────────────────

const ICD10_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
const ICD10_SYSTEM_SHORT = "icd-10";
const SNOMED_SYSTEM = "http://snomed.info/sct";

// ── Name / code extraction ──────────────────────────────────────

/**
 * Pick the condition name from `code`. Order of preference:
 * `.text` (most human-readable; what our exporter emits), then the
 * first non-empty `coding[].display`. Returns null when nothing
 * usable is present — the caller skips the entry.
 */
export function extractConditionName(
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
 * Extract the ICD-10 code from `code.coding[]`. Accepts both the
 * canonical HL7 URL and the shorthand "icd-10" some EHRs emit. The
 * export side writes the placeholder string "unknown" when no real
 * ICD-10 code is known — that round-trip artefact is rejected.
 * Returns the first matching entry, or null.
 */
export function extractIcd10Code(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (
      (c.system === ICD10_SYSTEM || c.system === ICD10_SYSTEM_SHORT) &&
      c.code &&
      c.code !== "unknown"
    ) {
      return c.code;
    }
  }
  return null;
}

/**
 * Extract the SNOMED CT code from `code.coding[]`. Returns the first
 * entry coded against the SNOMED system, or null.
 */
export function extractSnomedCode(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (c.system === SNOMED_SYSTEM && c.code && c.code !== "unknown") {
      return c.code;
    }
  }
  return null;
}

// ── Status mapping ──────────────────────────────────────────────

/**
 * FHIR Condition.clinicalStatus → internal DiagnosisStatus.
 *
 * The HL7 value set is wider than CareBridge's `active | resolved |
 * chronic` enum. Mapping rules:
 *   - active / recurrence / relapse → active (currently symptomatic)
 *   - remission                     → chronic (controlled but ongoing)
 *   - resolved / inactive           → resolved (no longer active)
 *
 * Anything missing or unrecognised defaults to active — diagnoses
 * imported into a real chart should be visible by default; treating
 * an unknown status as "absent" would silently drop the row from the
 * cross-specialty rule context.
 */
export function mapClinicalStatusToInternal(
  cc: InboundCodeableConcept | undefined,
): DiagnosisStatus {
  if (!cc) return "active";
  for (const c of cc.coding ?? []) {
    const code = c.code?.toLowerCase();
    if (!code) continue;
    switch (code) {
      case "active":
      case "recurrence":
      case "relapse":
        return "active";
      case "remission":
        return "chronic";
      case "resolved":
      case "inactive":
        return "resolved";
    }
  }
  return "active";
}

/**
 * `verificationStatus` of `entered-in-error` means the chart entry
 * was a mistake and should not be materialised — the caller skips the
 * row entirely. Mirrors `mapRequestStatusToInternal` returning null
 * for the same FHIR value on the medication side.
 */
export function isEnteredInError(
  cc: InboundCodeableConcept | undefined,
): boolean {
  if (!cc) return false;
  for (const c of cc.coding ?? []) {
    if (c.code?.toLowerCase() === "entered-in-error") return true;
  }
  return false;
}

// ── Date helpers ────────────────────────────────────────────────

/**
 * Extract the onset timestamp. `onsetDateTime` is the FHIR canonical
 * single-point value; `onsetPeriod.start` is the next-best signal
 * when the EHR only knows a date range. Returns null when neither is
 * set — diagnoses without onset still materialise (fail-open) so the
 * rule engine sees the presence of the condition.
 */
export function extractOnsetDateTime(
  cond: InboundCondition,
): string | null {
  if (cond.onsetDateTime) return cond.onsetDateTime;
  if (cond.onsetPeriod?.start) return cond.onsetPeriod.start;
  return null;
}

/**
 * Extract the recordedDate (when the diagnosis was first recorded in
 * the external EHR). Returns null when absent — the caller falls back
 * to the import wall-clock for `created_at`.
 */
export function extractRecordedDate(
  cond: InboundCondition,
): string | null {
  return cond.recordedDate ?? null;
}

/**
 * Extract abatement (resolved) timestamp. Currently the FHIR Condition
 * resource only carries `abatementDateTime` in the export path; we
 * accept that shape on import. Returns null when not resolved.
 */
function extractResolvedDate(cond: InboundCondition): string | null {
  return cond.abatementDateTime ?? null;
}

// ── Reference resolution ────────────────────────────────────────

/**
 * Resolve a Practitioner reference (e.g. `Practitioner/abc-123`) to
 * the internal user_id used by `diagnoses.diagnosed_by`.
 *
 * Minimum-viable implementation (#337): parse `Practitioner/{id}`
 * and return the raw id. Looking up the internal user row to verify
 * the practitioner exists is deferred to a follow-up — the import
 * path records the raw reference and a downstream reconciliation
 * job can normalise IDs later.
 *
 * Returns null when the reference is missing, malformed, or doesn't
 * match the Practitioner resource type.
 */
export function resolveRecorderReference(
  ref: InboundReference | undefined,
): string | null {
  if (!ref?.reference) return null;
  const match = /^Practitioner\/(.+)$/.exec(ref.reference);
  if (!match) return null;
  return match[1] ?? null;
}

// ── Severity extraction ─────────────────────────────────────────

/**
 * Map SNOMED severity codes to the internal severity enum. The codes
 * mirror what the FHIR R4 condition-severity value set publishes so
 * round-tripping a Condition through the export side (when it
 * eventually emits severity) lands the same value back.
 */
const SEVERITY_BY_SNOMED: Record<string, DiagnosisSeverity> = {
  "255604002": "mild",
  "6736007": "moderate",
  "24484000": "severe",
};

function mapSeverityText(text: string): DiagnosisSeverity | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === "mild") return "mild";
  if (t === "moderate") return "moderate";
  if (t === "severe") return "severe";
  return null;
}

/**
 * Extract a severity enum from a FHIR `severity` CodeableConcept.
 * Prefers SNOMED coding (single source of truth) and falls back to
 * coding.display, then top-level .text. Returns null when the value
 * is missing or unrecognised — the caller treats absent severity as
 * "unspecified" rather than smuggling a bad enum into the DB.
 */
export function extractSeverity(
  cc: InboundCodeableConcept | undefined,
): DiagnosisSeverity | null {
  if (!cc) return null;
  // 1. SNOMED codes first — single source of truth.
  for (const c of cc.coding ?? []) {
    if (!c.code) continue;
    if (c.system === SNOMED_SYSTEM || c.system === undefined) {
      const mapped = SEVERITY_BY_SNOMED[c.code];
      if (mapped) return mapped;
    }
  }
  // 2. Display text on any coding entry.
  for (const c of cc.coding ?? []) {
    if (c.display) {
      const m = mapSeverityText(c.display);
      if (m) return m;
    }
  }
  // 3. Free-text `text`.
  if (cc.text) return mapSeverityText(cc.text);
  return null;
}

// ── Main mapper ─────────────────────────────────────────────────

/**
 * Map a FHIR R4 Condition to a CareBridge `diagnoses` row.
 *
 * @param resource Sanitised FHIR Condition (importBundle has already
 *                 run sanitizeFreeText over every string).
 * @param patientId Internal patient id the bundle is being imported
 *                 against. The mapper trusts the caller to have
 *                 resolved subject.reference to this id.
 * @returns A row shape ready to insert, or null when the resource is
 *          unmappable (no code, verificationStatus=entered-in-error).
 */
export function mapFhirConditionToRow(
  resource: InboundCondition,
  patientId: string,
): MappedDiagnosisRow | null {
  if (isEnteredInError(resource.verificationStatus)) return null;

  const description = extractConditionName(resource.code);
  if (!description) return null;

  return {
    patient_id: patientId,
    description,
    icd10_code: extractIcd10Code(resource.code),
    snomed_code: extractSnomedCode(resource.code),
    status: mapClinicalStatusToInternal(resource.clinicalStatus),
    onset_date: extractOnsetDateTime(resource),
    resolved_date: extractResolvedDate(resource),
    diagnosed_by: resolveRecorderReference(resource.recorder),
    severity: extractSeverity(resource.severity),
    recorded_at: extractRecordedDate(resource),
  };
}
