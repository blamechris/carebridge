/**
 * Inbound FHIR R4 Patient → CareBridge `patients`-row mapper (issue #337).
 *
 * The export side (services/fhir-gateway/src/generators/patient.ts)
 * already serialises the internal `patients` table to FHIR. This mapper
 * is the inverse: it takes a FHIR Patient resource as ingested through
 * `importBundle` and produces the row shape the patient-records writer
 * would have produced for the same demographic record, so external EHRs
 * pushing patient identity (name, DOB, gender, MRN) materialise as a
 * real `patients` row rather than living only in the raw `fhir_resources`
 * table.
 *
 * Pure / side-effect-free — no DB writes, no PHI sanitization (the
 * caller has already sanitised by the time importBundle reaches us).
 * Returns `null` when the resource is unmappable (no name AND no MRN,
 * or `active: false` flagging the patient record as retired) so the
 * caller can skip-and-warn rather than crash the bundle.
 *
 * Mirrors the medication-mapper.ts pattern (#1066) field-for-field:
 *   - InboundPatient is loose (passthrough JSON), narrowed defensively
 *   - small focused extract* helpers per logical field
 *   - main `mapFhirPatientToRow` orchestrates the helpers
 *   - `source_system: "fhir_import"` tags the row for downstream filtering
 */

// ── Types we accept from the inbound bundle ─────────────────────
// As with the medication mapper, we intentionally don't import the
// export-side `FhirPatient` type — inbound payloads from external EHRs
// are looser (optional fields missing, unknown extras present). The
// bundle schema (services/fhir-gateway/src/schemas/bundle.ts) uses
// .passthrough() so the raw resource arrives as a generic record. We
// narrow defensively at each access.

interface InboundCoding {
  system?: string;
  code?: string;
  display?: string;
}

interface InboundCodeableConcept {
  coding?: InboundCoding[];
  text?: string;
}

interface InboundIdentifier {
  use?: string;
  type?: InboundCodeableConcept;
  system?: string;
  value?: string;
}

interface InboundHumanName {
  use?: string;
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

export interface InboundPatient {
  resourceType: "Patient";
  id?: string;
  /**
   * FHIR Patient.active. `false` signals the patient record has been
   * retired (the closest analogue to MedicationRequest.entered-in-error)
   * — we refuse to materialise so a corrected/duplicated patient record
   * doesn't slip into the live patient set.
   */
  active?: boolean;
  identifier?: InboundIdentifier[];
  name?: InboundHumanName[];
  birthDate?: string;
  gender?: string;
}

// ── Mapped output shape ─────────────────────────────────────────

/**
 * Shape of the row to insert into `patients`. Mirrors the column set
 * the patient-records writer would produce (services/patient-records/
 * src/router.ts `create`), minus the server-assigned fields (`id`,
 * `created_at`, `updated_at`) which the importBundle caller fills in
 * at write time.
 *
 * `name_hmac` / `mrn_hmac` are derived from `name` / `mrn` via
 * `hmacForIndex` at write time — they aren't carried in the mapper
 * output to keep this module pure (no key access, no encryption side
 * effects).
 */
export interface MappedPatientRow {
  name: string;
  date_of_birth: string | null;
  biological_sex: "male" | "female" | "unknown";
  mrn: string | null;
  source_system: string;
}

// ── Gender mapping ──────────────────────────────────────────────

/**
 * Internal biological_sex enum. The shared-types `biologicalSexSchema`
 * (packages/shared-types/src/patient.schemas.ts) is the source of
 * truth: `"male" | "female" | "unknown"`. The FHIR Patient.gender
 * value set is wider (also includes "other"); we collapse "other" to
 * "unknown" rather than coining a new internal value.
 */
type InternalSex = "male" | "female" | "unknown";

/**
 * Map FHIR Patient.gender → internal biological_sex.
 *
 * Case-insensitive. Unrecognised inputs (including "other") fall back
 * to "unknown" rather than throwing — the caller would rather land a
 * row with unknown sex than drop the patient entirely.
 */
export function mapGenderToSex(gender: string | undefined): InternalSex {
  if (!gender) return "unknown";
  const g = gender.trim().toLowerCase();
  if (g === "male") return "male";
  if (g === "female") return "female";
  // FHIR's "other" and "unknown" both collapse to internal "unknown".
  return "unknown";
}

// ── Name extraction ─────────────────────────────────────────────

/**
 * Pick the best HumanName entry from a Patient.name[] list.
 *
 * Order of preference:
 *   1. use === "official" — the legal/canonical name
 *   2. use === "usual"    — the everyday name (still authoritative)
 *   3. first entry in the array
 *
 * Returns null when the entry has nothing usable (no text, no family,
 * no given) so the caller can fall back to the MRN as a placeholder
 * name or skip the resource entirely.
 */
function pickBestNameEntry(
  names: InboundHumanName[],
): InboundHumanName | null {
  if (names.length === 0) return null;
  const byUse = (target: string) =>
    names.find((n) => n.use?.toLowerCase() === target);
  return byUse("official") ?? byUse("usual") ?? names[0] ?? null;
}

/**
 * Render a HumanName entry as a single internal name string.
 *
 * Prefers `text` (what our exporter emits, and what external EHRs
 * often populate for display). Falls back to `given` joined with
 * spaces followed by `family` — the inverse of the outbound
 * `parseName` in generators/patient.ts, so an exported-then-reimported
 * patient round-trips losslessly.
 *
 * Returns null when nothing usable is present.
 */
function renderName(entry: InboundHumanName): string | null {
  if (entry.text && entry.text.trim() !== "") return entry.text.trim();
  const given = (entry.given ?? [])
    .map((g) => g.trim())
    .filter((g) => g !== "");
  const family = entry.family?.trim() ?? "";
  const composed = [...given, family].filter((p) => p !== "").join(" ");
  if (composed === "") return null;
  return composed;
}

/**
 * Extract a display name from a FHIR Patient.name[].
 *
 * Public surface so unit tests can exercise the picker independently
 * of the main mapper.
 */
export function extractPatientName(
  names: InboundHumanName[] | undefined,
): string | null {
  if (!names || names.length === 0) return null;
  const best = pickBestNameEntry(names);
  if (!best) return null;
  return renderName(best);
}

// ── MRN extraction ──────────────────────────────────────────────

/**
 * Canonical CareBridge MRN system URL (mirrors generators/patient.ts).
 * The export side stamps every MRN with this `system` so a round-trip
 * import recognises it. We also accept any identifier carrying the
 * HL7 v2-0203 "MR" type code regardless of system, so MRNs from
 * external EHRs (Epic, Cerner) are picked up too.
 */
const CAREBRIDGE_MRN_SYSTEM = "https://carebridge.dev/fhir/sid/mrn";
const HL7_V2_0203_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0203";

/**
 * Pull the MRN out of a Patient.identifier[] list.
 *
 * Strategy:
 *   1. First identifier with type.coding.code === "MR" (the HL7 v2-0203
 *      Medical Record Number code — universally used by major EHRs).
 *   2. First identifier whose system matches CAREBRIDGE_MRN_SYSTEM
 *      (covers the case where a round-trip drops the type coding).
 *
 * Identifiers without a `value` are skipped — an empty MRN is no MRN.
 *
 * Returns null when no MRN-shaped identifier is found.
 */
export function extractMrn(
  identifiers: InboundIdentifier[] | undefined,
): string | null {
  if (!identifiers || identifiers.length === 0) return null;

  // Pass 1: any identifier with type.coding[].code === "MR".
  for (const ident of identifiers) {
    if (!ident.value) continue;
    for (const c of ident.type?.coding ?? []) {
      if (c.code === "MR") {
        // Optional system tightening: when system is present, require
        // it to be the HL7 v2-0203 codesystem. Most external EHRs
        // populate this; some omit it, and we tolerate the omission.
        if (c.system === undefined || c.system === HL7_V2_0203_SYSTEM) {
          return ident.value;
        }
      }
    }
  }

  // Pass 2: identifier whose `system` matches the CareBridge MRN
  // namespace (handles type-coding-stripped round-trips).
  for (const ident of identifiers) {
    if (!ident.value) continue;
    if (ident.system === CAREBRIDGE_MRN_SYSTEM) return ident.value;
  }

  return null;
}

// ── birthDate extraction ────────────────────────────────────────

/**
 * Normalise Patient.birthDate to the YYYY-MM-DD shape the internal
 * `patients.date_of_birth` column expects. FHIR R4 birthDate is
 * already date-only in conformant payloads, but defensively strip
 * any time component if an external EHR included one.
 *
 * Returns null when birthDate is absent or doesn't start with a
 * recognisable date prefix.
 */
function extractBirthDate(birthDate: string | undefined): string | null {
  if (!birthDate) return null;
  // Accept "1980-05-12" or "1980-05-12T00:00:00.000Z" — slice to date
  // prefix and validate the basic shape.
  const datePart = birthDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return datePart;
}

// ── Main mapper ─────────────────────────────────────────────────

const SOURCE_SYSTEM_TAG = "fhir_import";

/**
 * Map a FHIR R4 Patient to a CareBridge `patients` row.
 *
 * @param resource Sanitised FHIR Patient (importBundle has already
 *                 run sanitizeFreeText over every string).
 * @returns A row shape ready to insert, or null when the resource is
 *          unmappable (no name AND no MRN, or active=false flagging
 *          the patient record as retired).
 *
 * Note: this does NOT assign an internal id. The importBundle caller
 * either generates one (`crypto.randomUUID()`) or reconciles to an
 * existing internal patient via a separate code path. Keeping the id
 * out of the mapper preserves the pure-function contract and lets
 * the materialisation pass run inside the same transaction as the
 * raw FHIR insert without coupling to id-allocation strategy.
 */
export function mapFhirPatientToRow(
  resource: InboundPatient,
): MappedPatientRow | null {
  // active=false → patient record retired by source. Skip materialisation
  // to mirror the medication-mapper's entered-in-error behaviour.
  if (resource.active === false) return null;

  const mrn = extractMrn(resource.identifier);
  const nameFromHuman = extractPatientName(resource.name);

  // Refuse anonymous rows: a Patient with neither a name nor an MRN is
  // unidentifiable. Returning null lets the caller emit a structured
  // warning and continue with the rest of the bundle.
  if (!nameFromHuman && !mrn) return null;

  // When the FHIR Patient carries an MRN but no demographic name, use
  // the MRN string as the placeholder name so the row is still
  // identifiable in downstream UI. The MRN is encrypted at rest just
  // like a real name, so this carries the same PHI characteristics.
  const name = nameFromHuman ?? mrn;
  if (!name) return null; // unreachable per the check above; satisfies TS

  return {
    name,
    date_of_birth: extractBirthDate(resource.birthDate),
    biological_sex: mapGenderToSex(resource.gender),
    mrn,
    source_system: SOURCE_SYSTEM_TAG,
  };
}
