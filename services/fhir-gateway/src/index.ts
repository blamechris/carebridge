export {
  fhirGatewayRouter,
  type FhirGatewayRouter,
  type Context as FhirGatewayContext,
} from "./router.js";
export { fhirBundleSchema, type FhirBundle } from "./schemas/bundle.js";

// Outbound resource generators (#394 — used by the api-gateway REST surface
// to serialise internal rows as FHIR R4 resources for /fhir/* responses).
export {
  toFhirPatient,
  toFhirVitalObservation,
  toFhirLabObservation,
  toFhirCondition,
  toFhirMedicationStatement,
  toFhirMedicationRequest,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirProcedure,
  toFhirPractitioner,
  type FhirObservation,
} from "./generators/index.js";

// Inbound resource mappers (#337/#1066 — used by importBundle and the
// Epic FHIR client (#390) to project external FHIR resources into the
// CareBridge row shapes the clinical-data writers consume).
export {
  mapFhirPatientToRow,
  type InboundPatient,
  type MappedPatientRow,
} from "./patient-mapper.js";
export {
  mapMedicationRequestToRow,
  mapMedicationStatementToRow,
  type InboundMedicationRequest,
  type InboundMedicationStatement,
  type MappedMedicationRow,
} from "./medication-mapper.js";
export {
  classifyObservationCategory,
  mapFhirObservationToVitalRow,
  mapFhirObservationToLabResultRow,
  type InboundObservation,
  type MappedVitalRow,
  type MappedLabResultRow,
  type ObservationCategory,
} from "./observation-mapper.js";
export {
  mapFhirConditionToRow,
  type InboundCondition,
  type MappedDiagnosisRow,
} from "./condition-mapper.js";
export {
  mapFhirAllergyIntoleranceToRow,
  type InboundAllergyIntolerance,
  type MappedAllergyRow,
} from "./allergy-mapper.js";
