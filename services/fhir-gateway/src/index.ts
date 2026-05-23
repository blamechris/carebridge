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
