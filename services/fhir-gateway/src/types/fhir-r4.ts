/**
 * Subset of FHIR R4 type definitions used by the CareBridge FHIR gateway.
 * Shared datatypes consumed by resource generators.
 */

export interface Meta {
  profile?: string[];
  lastUpdated?: string;
  versionId?: string;
}

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
  display?: string;
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

export interface Period {
  start?: string;
  end?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  meta?: Meta;
  identifier?: Identifier[];
  name?: HumanName[];
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
}

// Backwards-compatible aliases (deprecated — prefer unprefixed names)
export type FhirMeta = Meta;
export type FhirCoding = Coding;
export type FhirCodeableConcept = CodeableConcept;
export type FhirIdentifier = Identifier;
export type FhirHumanName = HumanName;
