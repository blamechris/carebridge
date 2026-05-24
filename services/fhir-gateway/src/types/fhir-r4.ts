/**
 * Subset of FHIR R4 type definitions used by the CareBridge FHIR gateway.
 * Shared primitives used across resource generators (Patient, Observation,
 * Condition, AllergyIntolerance, MedicationStatement, ...).
 */

export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Quantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface Reference {
  reference?: string;
  /** Human-readable label for the referenced resource. */
  display?: string;
}

export interface Period {
  start?: string;
  end?: string;
}

export interface Identifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  type?: CodeableConcept;
  system?: string;
  value?: string;
}

export interface HumanName {
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
  /** Honorifics (e.g. "Dr.", "Mrs."). FHIR R4 HumanName.prefix. */
  prefix?: string[];
  /** Credentials / generational (e.g. "MD", "RN", "PhD", "III"). FHIR R4 HumanName.suffix. */
  suffix?: string[];
}

export interface Meta {
  profile?: string[];
  lastUpdated?: string;
  versionId?: string;
}

export interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: Quantity;
}

// ─── Backwards-compat aliases (Fhir-prefixed names) ─────────────
export type FhirCoding = Coding;
export type FhirCodeableConcept = CodeableConcept;
export type FhirQuantity = Quantity;
export type FhirReference = Reference;
export type FhirPeriod = Period;
export type FhirIdentifier = Identifier;
export type FhirHumanName = HumanName;
export type FhirMeta = Meta;

// ─── ContactPoint (telecom) ─────────────────────────────────────
export interface ContactPoint {
  system?: "phone" | "fax" | "email" | "pager" | "url" | "sms" | "other";
  value?: string;
  use?: "home" | "work" | "temp" | "old" | "mobile";
  rank?: number;
}

// ─── Attachment ─────────────────────────────────────────────────
export interface Attachment {
  contentType?: string;
  language?: string;
  data?: string;
  url?: string;
  size?: number;
  hash?: string;
  title?: string;
  creation?: string;
}

// ─── Timing (dosage support) ────────────────────────────────────
export interface TimingRepeat {
  frequency?: number;
  period?: number;
  periodUnit?: "s" | "min" | "h" | "d" | "wk" | "mo" | "a";
}

export interface Timing {
  repeat?: TimingRepeat;
  code?: CodeableConcept;
}

// ─── Dosage ─────────────────────────────────────────────────────
export interface DoseAndRate {
  type?: CodeableConcept;
  doseQuantity?: Quantity;
  rateQuantity?: Quantity;
}

export interface Ratio {
  numerator?: Quantity;
  denominator?: Quantity;
}

export interface DosageInstruction {
  text?: string;
  route?: CodeableConcept;
  timing?: Timing;
  doseAndRate?: DoseAndRate[];
  /**
   * Upper bound on the cumulative dose administered over a period
   * (e.g. "max 4 doses/day"). FHIR R4 Dosage.maxDosePerPeriod is a
   * Ratio — numerator is the dose count or quantity, denominator is
   * the time unit. Used by the daily-dose rule to bound PRN regimens
   * via {@link extractMaxDosesPerDay}. (#935)
   */
  maxDosePerPeriod?: Ratio;
}

// ─── Patient resource ───────────────────────────────────────────
export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  meta?: Meta;
  identifier?: Identifier[];
  name?: HumanName[];
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
}

// ─── Encounter resource ─────────────────────────────────────────
export interface EncounterParticipant {
  type?: CodeableConcept[];
  individual?: Reference;
}

export interface EncounterLocation {
  location: Reference;
  status?: "planned" | "active" | "reserved" | "completed";
  period?: Period;
}

export interface FhirEncounter {
  resourceType: "Encounter";
  id: string;
  meta?: Meta;
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled" | "entered-in-error" | "unknown";
  class: Coding;
  type?: CodeableConcept[];
  subject?: Reference;
  period?: Period;
  participant?: EncounterParticipant[];
  location?: EncounterLocation[];
  serviceProvider?: Reference;
  reasonCode?: CodeableConcept[];
}

// ─── Procedure resource ─────────────────────────────────────────
export interface ProcedurePerformer {
  actor: Reference;
  function?: CodeableConcept;
}

export interface FhirProcedure {
  resourceType: "Procedure";
  id: string;
  meta?: Meta;
  status: "preparation" | "in-progress" | "not-done" | "on-hold" | "stopped" | "completed" | "entered-in-error" | "unknown";
  code?: CodeableConcept;
  subject: Reference;
  performedDateTime?: string;
  performedPeriod?: Period;
  performer?: ProcedurePerformer[];
  location?: Reference;
  reasonCode?: CodeableConcept[];
}

// ─── MedicationRequest resource ─────────────────────────────────
export interface FhirMedicationRequest {
  resourceType: "MedicationRequest";
  id: string;
  meta?: Meta;
  status: "active" | "on-hold" | "cancelled" | "completed" | "entered-in-error" | "stopped" | "draft" | "unknown";
  intent: "proposal" | "plan" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  medicationCodeableConcept?: CodeableConcept;
  subject: Reference;
  authoredOn?: string;
  requester?: Reference;
  dosageInstruction?: DosageInstruction[];
}

// ─── Practitioner resource ──────────────────────────────────────
export interface PractitionerQualification {
  code: CodeableConcept;
}

export interface FhirPractitioner {
  resourceType: "Practitioner";
  id: string;
  meta?: Meta;
  name?: HumanName[];
  identifier?: Identifier[];
  telecom?: ContactPoint[];
  qualification?: PractitionerQualification[];
}

// ─── DocumentReference resource ─────────────────────────────────
export interface DocumentReferenceContent {
  attachment: Attachment;
}

export interface FhirDocumentReference {
  resourceType: "DocumentReference";
  id: string;
  meta?: Meta;
  status: "current" | "superseded" | "entered-in-error";
  type?: CodeableConcept;
  subject?: Reference;
  date?: string;
  author?: Reference[];
  content: DocumentReferenceContent[];
}

// ─── Observation resource ───────────────────────────────────────
export interface ObservationReferenceRange {
  low?: Quantity;
  high?: Quantity;
}

export interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  meta?: Meta;
  status: "final" | "preliminary" | "registered" | "amended";
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject?: Reference;
  effectiveDateTime?: string;
  valueQuantity?: Quantity;
  component?: ObservationComponent[];
  referenceRange?: ObservationReferenceRange[];
}

// ─── Condition resource ─────────────────────────────────────────
/**
 * Local coding shape used by Condition / AllergyIntolerance generators:
 * Condition and AllergyIntolerance codings are always emitted with both
 * `system` and `code` populated (display is optional).
 */
export type FhirRequiredCoding = Required<Pick<Coding, "system" | "code">> &
  Pick<Coding, "display">;

export interface FhirCondition {
  resourceType: "Condition";
  id: string;
  meta?: Meta;
  clinicalStatus: {
    coding: FhirRequiredCoding[];
  };
  verificationStatus: {
    coding: FhirRequiredCoding[];
  };
  code: {
    coding: FhirRequiredCoding[];
    text: string;
  };
  subject: {
    reference: string;
  };
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  recorder?: {
    reference: string;
  };
}

// ─── AllergyIntolerance resource ────────────────────────────────
export type FhirAllergyCategory =
  | "food"
  | "medication"
  | "environment"
  | "biologic";

export interface FhirAllergyReaction {
  substance?: {
    coding: FhirRequiredCoding[];
    text: string;
  };
  manifestation: {
    coding: FhirRequiredCoding[];
    text: string;
  }[];
  severity?: "mild" | "moderate" | "severe";
}

export interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id: string;
  meta?: Meta;
  clinicalStatus: {
    coding: FhirRequiredCoding[];
  };
  verificationStatus: {
    coding: FhirRequiredCoding[];
  };
  category?: FhirAllergyCategory[];
  code: {
    coding: FhirRequiredCoding[];
    text: string;
  };
  patient: {
    reference: string;
  };
  recordedDate?: string;
  criticality?: "low" | "high" | "unable-to-assess";
  reaction?: FhirAllergyReaction[];
}
