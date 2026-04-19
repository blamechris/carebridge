export {
  toFhirVitalObservation,
  toFhirLabObservation,
  type FhirObservation,
} from "./observation.js";
export { toFhirPatient } from "./patient.js";
export { toFhirCondition } from "./condition.js";
export { toFhirMedicationStatement } from "./medication-statement.js";
export { toFhirAllergyIntolerance } from "./allergy-intolerance.js";
export { toFhirEncounter } from "./encounter.js";
export { toFhirProcedure } from "./procedure.js";
export { toFhirPractitioner, isClinicalRole } from "./practitioner.js";
export { toFhirMedicationRequest } from "./medication-request.js";
