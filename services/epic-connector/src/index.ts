/**
 * @carebridge/epic-connector — Epic SMART on FHIR integration.
 *
 * #389 ships SMART Backend Services authentication: RS384 JWT
 * assertion, OAuth2 client-credentials token exchange, expiry-aware
 * caching, and SMART configuration discovery.
 *
 * #390 adds the typed FHIR R4 client + Epic→CareBridge converters.
 *
 * Follow-ups will add the sync worker (#391), App Launch (#392), and
 * outbound flag push (#393).
 */
export { loadEpicConfig, type EpicConfig } from "./config.js";
export {
  EPIC_SANDBOX_TOKEN_URL,
  EPIC_SANDBOX_FHIR_BASE_URL,
} from "./config.js";
export {
  buildClientAssertion,
  type BuildAssertionArgs,
} from "./jwt-assertion.js";
export {
  EpicTokenClient,
  DEFAULT_SYSTEM_SCOPES,
  type TokenResponse,
} from "./token-client.js";
export {
  fetchSmartConfiguration,
  smartConfigurationUrl,
  type SmartConfiguration,
} from "./capability.js";
export {
  generateKeypair,
  publicKeyFingerprint,
  type GeneratedKeyPair,
  type PublicJwk,
  type GenerateOptions,
} from "./keygen.js";
export {
  EpicFhirClient,
  type EpicFhirClientOptions,
  type EpicResourceType,
} from "./fhir-client.js";
export type {
  FhirBundle,
  FhirBundleEntry,
  FhirBundleLink,
  FhirResource,
  EpicSearchParams,
  OperationOutcome,
} from "./fhir-types.js";
export {
  EPIC_SOURCE_SYSTEM_TAG,
  epicPatientToRow,
  epicMedicationRequestToRow,
  epicMedicationStatementToRow,
  epicObservationToRow,
  epicConditionToRow,
  epicAllergyToRow,
  type EpicDiagnosisRow,
  type EpicLabResultRow,
  type EpicObservationConversion,
} from "./converters.js";
