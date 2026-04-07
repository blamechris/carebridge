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
