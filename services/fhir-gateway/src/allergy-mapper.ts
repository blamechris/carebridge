/**
 * Inbound FHIR R4 AllergyIntolerance → CareBridge `allergies`-row mapper
 * (issue #337).
 *
 * The export side (services/fhir-gateway/src/generators/allergy-intolerance.ts)
 * already serialises the internal `allergies` table to FHIR. This mapper is
 * the inverse: it takes a FHIR resource as ingested through `importBundle`
 * and produces the row shape the patient-records writer would have produced
 * for the same allergy, so external EHRs pushing structured allergy data
 * (RxNorm/SNOMED codings, reaction descriptions, criticality, severity)
 * can drive the ai-oversight allergy-medication rules the same way internal
 * tRPC writes do today.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitization (the caller
 * has already sanitised by the time importBundle reaches us). Returns
 * `null` when the resource is unmappable (missing allergen name,
 * verificationStatus: entered-in-error) so the caller can skip-and-warn
 * rather than crash the bundle.
 */

// ── Types we accept from the inbound bundle ─────────────────────
// We don't import the export-side FHIR types here because inbound payloads
// from external EHRs are looser than what our exporter emits (optional
// fields may be missing, unknown extra fields present). The bundle schema
// (services/fhir-gateway/src/schemas/bundle.ts) uses .passthrough() so the
// raw resource arrives as a generic Record<string, unknown> — we narrow
// defensively at each access.

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

interface InboundReaction {
  substance?: InboundCodeableConcept;
  manifestation?: InboundCodeableConcept[];
  description?: string;
  /**
   * FHIR R4 reaction severity is a strict enum (mild | moderate | severe).
   * We accept a wider string here to defend against external EHRs sending
   * non-conformant values, and narrow in mapReactionSeverityToInternal.
   */
  severity?: string;
  onset?: string;
}

export interface InboundAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id?: string;
  clinicalStatus?: InboundCodeableConcept;
  verificationStatus?: InboundCodeableConcept;
  category?: string[];
  criticality?: string;
  code?: InboundCodeableConcept;
  patient?: InboundReference;
  /**
   * FHIR R4 onset[x] — we accept the most common form, onsetDateTime,
   * and onsetPeriod (start used). onsetAge / onsetRange / onsetString
   * are not normalised here because they can't be converted to ISO 8601
   * without making clinical assumptions; callers that need those should
   * pre-resolve.
   */
  onsetDateTime?: string;
  onsetPeriod?: InboundPeriod;
  recordedDate?: string;
  recorder?: InboundReference;
  asserter?: InboundReference;
  reaction?: InboundReaction[];
}

// ── Internal enums (mirrors packages/shared-types/clinical-data) ─

/**
 * Internal severity enum. The DB column is free-text but the schema
 * (allergySeveritySchema) constrains writes to this set. We deliberately
 * DO NOT emit "critical" from inbound mapping — FHIR R4 has no
 * corresponding source token, and back-filling it would require a
 * clinical-judgement call we can't safely make at the gateway layer.
 */
type AllergySeverity = "mild" | "moderate" | "severe";

/**
 * Internal verification_status. Mirrors the export-side reverse mapping
 * in generators/allergy-intolerance.ts.
 */
type AllergyVerificationStatus =
  | "confirmed"
  | "unconfirmed"
  | "refuted";

// ── Mapped output shape ─────────────────────────────────────────

/**
 * Shape of the row to insert into `allergies`. Mirrors the column set in
 * packages/db-schema/src/schema/patients.ts plus the explicit caller-
 * supplied `patient_id` (the FHIR `patient.reference` carries the patient
 * id, but the importBundle path validates the patient resolution itself
 * and passes a verified id in).
 *
 * `onset_at` is conceptually distinct from the DB's `created_at`: it's
 * the clinical onset of the allergy, not the record-creation time. The
 * caller is responsible for setting `created_at` to the import wall-clock
 * time when inserting the row.
 */
export interface MappedAllergyRow {
  patient_id: string;
  allergen: string;
  rxnorm_code: string | null;
  snomed_code: string | null;
  reaction: string | null;
  severity: AllergySeverity | null;
  verification_status: AllergyVerificationStatus;
  onset_at: string | null;
  /**
   * Raw external id of the recording practitioner (parsed from
   * `Practitioner/{id}`). Storing the raw external id is the
   * minimum-viable approach (#337) — looking up the internal user row
   * to verify the practitioner exists is deferred to a follow-up.
   */
  recorded_by: string | null;
  source_system: string | null;
}

// ── Allergen name extraction ────────────────────────────────────

/**
 * Pick the allergen name from `code`. Order of preference:
 *   1. code.text (most human-readable; what our exporter emits)
 *   2. first non-empty code.coding[].display
 *
 * Returns null when nothing usable is present — the caller skips the
 * entry. A SNOMED/RxNorm code without a display label is not a usable
 * allergen name on its own; we'd be writing the raw integer into the
 * `allergen` column otherwise.
 */
export function extractAllergen(
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
 * Extract the RxNorm code from `code.coding[]`. Returns the first entry
 * coded against the RxNorm system, or null. Rejects the placeholder
 * "unknown" code our exporter emits for un-coded allergens.
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

/**
 * Extract a SNOMED CT code from `code.coding[]`. Returns the first entry
 * coded against the SNOMED CT system, or null. Rejects the "unknown"
 * placeholder.
 */
export function extractSnomedCode(
  cc: InboundCodeableConcept | undefined,
): string | null {
  if (!cc) return null;
  for (const c of cc.coding ?? []) {
    if (
      c.system === "http://snomed.info/sct" &&
      c.code &&
      c.code !== "unknown"
    ) {
      return c.code;
    }
  }
  return null;
}

// ── Severity mapping ────────────────────────────────────────────

/**
 * Map FHIR criticality (low | high | unable-to-assess) to the internal
 * severity enum. Criticality is "future risk" not "observed severity";
 * we collapse it to a coarse internal severity to seed the column for
 * EHRs that don't supply reaction.severity directly.
 *
 *   high              → severe
 *   low               → mild
 *   unable-to-assess  → null  (no internal analogue)
 *
 * Returns null on undefined or unrecognised values.
 */
export function mapCriticalityToSeverity(
  criticality: string | undefined,
): AllergySeverity | null {
  switch (criticality) {
    case "high":
      return "severe";
    case "low":
      return "mild";
    case "unable-to-assess":
      return null;
    default:
      return null;
  }
}

/**
 * Map a FHIR reaction.severity token (mild | moderate | severe) to the
 * internal severity enum. Returns null for missing or unrecognised
 * values; the caller falls back to criticality-derived severity.
 */
export function mapReactionSeverityToInternal(
  severity: string | undefined,
): AllergySeverity | null {
  switch (severity) {
    case "mild":
    case "moderate":
    case "severe":
      return severity;
    default:
      return null;
  }
}

// ── Reaction text extraction ────────────────────────────────────

/**
 * Pick a human-readable reaction description from the first
 * `reaction[]` entry. Order of preference:
 *   1. reaction.description (free text — most descriptive)
 *   2. manifestation[0].text
 *   3. manifestation[0].coding[0].display
 *
 * Returns null when none of these yield a usable string. This is a
 * fail-open: a missing reaction column is preferable to fabricating a
 * generic "Unknown reaction" string that the ai-oversight rules might
 * trip on.
 */
export function extractReactionDescription(
  reaction: InboundReaction | undefined,
): string | null {
  if (!reaction) return null;
  if (reaction.description && reaction.description.trim() !== "") {
    return reaction.description.trim();
  }
  const manifestation = reaction.manifestation?.[0];
  if (manifestation) {
    if (manifestation.text && manifestation.text.trim() !== "") {
      return manifestation.text.trim();
    }
    for (const c of manifestation.coding ?? []) {
      if (c.display && c.display.trim() !== "") return c.display.trim();
    }
  }
  return null;
}

// ── Onset extraction ────────────────────────────────────────────

/**
 * Extract a clinical onset timestamp from the FHIR R4 onset[x] choice
 * type. We accept onsetDateTime (most common) and onsetPeriod.start.
 *
 * onsetAge / onsetRange / onsetString are NOT normalised here — they
 * require clinical assumptions (a 30-year-old patient's "Age 5" onset
 * isn't computable from the resource alone) and would silently produce
 * misleading timestamps. Callers that need those should pre-resolve.
 */
export function extractOnsetDateTime(
  resource: Pick<InboundAllergyIntolerance, "onsetDateTime" | "onsetPeriod">,
): string | null {
  if (resource.onsetDateTime) return resource.onsetDateTime;
  if (resource.onsetPeriod?.start) return resource.onsetPeriod.start;
  return null;
}

// ── Reference resolution ────────────────────────────────────────

/**
 * Resolve a Practitioner reference (e.g. `Practitioner/abc-123`) to
 * the internal user_id used by `allergies.recorded_by`.
 *
 * Minimum-viable implementation (#337): parse `Practitioner/{id}` and
 * return the raw id. Looking up the internal user row to verify the
 * practitioner exists is deferred to a follow-up — the import path
 * already records the raw reference and a downstream reconciliation
 * job can normalise IDs later. This mirrors the equivalent helper in
 * the MedicationRequest mapper (#1066).
 *
 * Returns null when the reference is missing, malformed, or doesn't
 * match the Practitioner resource type — Patient self-reported
 * allergies are common and should leave recorded_by null rather than
 * storing the patient id in a clinician column.
 */
export function resolveRecorderReference(
  ref: InboundReference | undefined,
): string | null {
  if (!ref?.reference) return null;
  const match = /^Practitioner\/(.+)$/.exec(ref.reference);
  if (!match) return null;
  return match[1] ?? null;
}

// ── Verification status mapping ─────────────────────────────────

/**
 * FHIR verificationStatus → internal verification_status. The full FHIR
 * value set is {unconfirmed, confirmed, refuted, entered-in-error,
 * presumed}.
 *
 * `entered-in-error` returns null to signal "skip this entry" — a chart
 * correction means the record was a mistake and should not be
 * materialised. Unknown values default to unconfirmed (fail-safe: the
 * record imports but is flagged as needing clinician review).
 */
export function mapVerificationStatusToInternal(
  status: string | undefined,
): AllergyVerificationStatus | null {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "refuted":
      return "refuted";
    case "unconfirmed":
      return "unconfirmed";
    case "entered-in-error":
      return null; // skip — chart mistake
    default:
      return "unconfirmed";
  }
}

/**
 * Extract the verificationStatus code from the FHIR CodeableConcept
 * wrapper (.coding[].code matching the canonical system, or .coding[]
 * fallback). Returns undefined when nothing matches so the caller's
 * default kicks in.
 */
function extractVerificationCode(
  cc: InboundCodeableConcept | undefined,
): string | undefined {
  if (!cc) return undefined;
  for (const c of cc.coding ?? []) {
    if (
      c.system ===
        "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification" &&
      c.code
    ) {
      return c.code;
    }
  }
  // Tolerant: some EHRs drop the system on locally-coded statuses.
  for (const c of cc.coding ?? []) {
    if (c.code) return c.code;
  }
  return undefined;
}

// ── Main mapper function ────────────────────────────────────────

const SOURCE_SYSTEM_TAG = "fhir_import";

/**
 * Map a FHIR R4 AllergyIntolerance to a CareBridge `allergies` row.
 *
 * @param resource Sanitised FHIR resource (importBundle has already run
 *                 sanitizeFreeText over every string).
 * @param patientId Internal patient id the bundle is being imported
 *                 against. The mapper trusts the caller to have
 *                 resolved patient.reference to this id.
 * @returns A row shape ready to insert, or null when the resource is
 *          unmappable:
 *           - missing code (no allergen identifier at all)
 *           - allergen name unrecoverable (no text, no coding.display)
 *           - verificationStatus: entered-in-error (chart correction)
 */
export function mapFhirAllergyIntoleranceToRow(
  resource: InboundAllergyIntolerance,
  patientId: string,
): MappedAllergyRow | null {
  // Reject chart corrections up-front so we never spend cycles on them.
  const verificationCode = extractVerificationCode(resource.verificationStatus);
  const verification = mapVerificationStatusToInternal(verificationCode);
  if (verification === null) return null;

  const allergen = extractAllergen(resource.code);
  if (!allergen) return null;

  const rxnormCode = extractRxNormCode(resource.code);
  const snomedCode = extractSnomedCode(resource.code);

  const firstReaction = resource.reaction?.[0];
  const reactionText = extractReactionDescription(firstReaction);

  // Severity precedence: an explicit reaction.severity (clinician's
  // assessment of THIS reaction) outranks the criticality-derived
  // fallback (future-risk shorthand). Both null leaves severity null
  // rather than fabricating one.
  const severity =
    mapReactionSeverityToInternal(firstReaction?.severity) ??
    mapCriticalityToSeverity(resource.criticality);

  // Onset precedence: recordedDate (when the record was created in the
  // chart, always present on conformant exports) outranks onset[x]
  // (clinical event time). The DB column is best-effort — neither value
  // is required, and many imported records have neither populated.
  const onsetAt =
    resource.recordedDate ?? extractOnsetDateTime(resource);

  // Recorder precedence: recorder (who created the record) outranks
  // asserter (who said the allergy exists — sometimes the patient).
  // Patient-as-asserter is a common pattern and we deliberately leave
  // recorded_by null in that case rather than store a patient id in a
  // clinician column.
  const recordedBy =
    resolveRecorderReference(resource.recorder) ??
    resolveRecorderReference(resource.asserter);

  return {
    patient_id: patientId,
    allergen,
    rxnorm_code: rxnormCode,
    snomed_code: snomedCode,
    reaction: reactionText,
    severity,
    verification_status: verification,
    onset_at: onsetAt,
    recorded_by: recordedBy,
    source_system: SOURCE_SYSTEM_TAG,
  };
}
