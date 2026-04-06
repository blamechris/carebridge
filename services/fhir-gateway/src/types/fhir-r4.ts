/**
 * Subset of FHIR R4 type definitions used by the CareBridge FHIR gateway.
 * Covers the Patient resource and its immediate dependencies.
 */

export interface FhirMeta {
  profile?: string[];
  lastUpdated?: string;
  versionId?: string;
}

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  type?: FhirCodeableConcept;
  system?: string;
  value?: string;
}

export interface FhirHumanName {
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  meta?: FhirMeta;
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
}
