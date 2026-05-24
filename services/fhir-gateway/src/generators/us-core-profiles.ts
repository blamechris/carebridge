/**
 * US Core (HL7 FHIR R4) StructureDefinition URLs.
 *
 * Each exported FHIR resource declares conformance to a US Core profile via
 * `Resource.meta.profile`. Centralising the URLs here keeps every generator
 * in lock-step with the same canonical references and makes it easy to
 * audit the set of profiles CareBridge claims to support.
 *
 * Resource-level notes:
 *  - Patient, Condition, AllergyIntolerance, Encounter, Procedure,
 *    MedicationRequest each have a single canonical US Core profile.
 *  - Observation depends on category — vitals declare `us-core-vital-signs`,
 *    lab results declare `us-core-laboratory-result-observation`.
 *  - MedicationStatement was deprecated in US Core 5+ and has no current
 *    US Core profile; that generator intentionally does not populate
 *    meta.profile.
 *  - Practitioner is handled separately (issue #947).
 *
 * Reference: https://hl7.org/fhir/us/core/
 */

const BASE = "http://hl7.org/fhir/us/core/StructureDefinition";

/** US Core Patient profile URL. */
export const US_CORE_PATIENT = `${BASE}/us-core-patient`;

/**
 * US Core Condition profile URL.
 *
 * The condition generator currently emits diagnoses without a category
 * coding, so we cannot disambiguate between
 * `us-core-condition-encounter-diagnosis` and
 * `us-core-condition-problems-and-health-concerns` from the resource shape
 * alone. Encounter-diagnosis is the more conservative default for the
 * inbound `diagnoses` table (which is sourced from clinical encounters).
 */
export const US_CORE_CONDITION =
  `${BASE}/us-core-condition-encounter-diagnosis`;

/** US Core MedicationRequest profile URL. */
export const US_CORE_MEDICATION_REQUEST = `${BASE}/us-core-medicationrequest`;

/** US Core AllergyIntolerance profile URL. */
export const US_CORE_ALLERGY_INTOLERANCE = `${BASE}/us-core-allergyintolerance`;

/** US Core Encounter profile URL. */
export const US_CORE_ENCOUNTER = `${BASE}/us-core-encounter`;

/** US Core Procedure profile URL. */
export const US_CORE_PROCEDURE = `${BASE}/us-core-procedure`;

/** US Core Vital Signs Observation profile URL. */
export const US_CORE_VITAL_SIGNS = `${BASE}/us-core-vital-signs`;

/** US Core Laboratory Result Observation profile URL. */
export const US_CORE_LABORATORY_RESULT =
  `${BASE}/us-core-laboratory-result-observation`;
