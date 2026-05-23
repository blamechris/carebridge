/**
 * @carebridge/epic-connector — Epic SMART on FHIR integration.
 *
 * #389 ships SMART Backend Services authentication: RS384 JWT
 * assertion, OAuth2 client-credentials token exchange, expiry-aware
 * caching, and SMART configuration discovery.
 *
 * Follow-ups will add the typed FHIR client (#390), sync worker (#391),
 * App Launch (#392), and outbound flag push (#393).
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
