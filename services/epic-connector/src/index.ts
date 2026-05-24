/**
 * @carebridge/epic-connector — Epic SMART on FHIR integration.
 *
 * #389 ships SMART Backend Services authentication: RS384 JWT
 * assertion, OAuth2 client-credentials token exchange, expiry-aware
 * caching, and SMART configuration discovery.
 *
 * #390 adds the typed FHIR R4 client + Epic→CareBridge converters.
 *
 * #391 adds the BullMQ sync worker, persistence layer, clinical-event
 * emission, and tRPC surface for sync orchestration / status.
 *
 * Follow-ups will add App Launch (#392) and outbound flag push (#393).
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
  EpicFhirError,
  type EpicFhirClientOptions,
  type EpicResourceType,
} from "./fhir-client.js";
export {
  EPIC_ERROR_CODES,
  type EpicErrorCode,
} from "./epic-error-codes.js";
export {
  operationOutcomeHasIssueCode,
} from "./fhir-types.js";
export type {
  FhirBundle,
  FhirBundleEntry,
  FhirBundleLink,
  FhirResource,
  EpicSearchParams,
  OperationOutcome,
  OperationOutcomeIssue,
  OperationOutcomeIssueCoding,
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
export {
  runFullSync,
  runIncrementalSync,
  runSingleResourceSync,
  isMissingRequiredElementError,
  describeMissingElement,
  sanitizeMissingElementForPersistence,
  SUPPORTED_RESOURCE_TYPES,
  type SyncResourceType,
  type SyncResult,
  type SyncJobDeps,
  type EmitFn,
  type SkippedSubResource,
} from "./sync/sync-jobs.js";
export {
  getSyncState,
  getAllSyncStatesForPatient,
  listRecentFailures,
  markRunning,
  markOk,
  markFailed,
  type EpicSyncStateRow,
  type EpicSyncStatusValue,
  type SkippedSubResourceRecord,
} from "./sync/sync-state-repo.js";
export {
  loadFanoutConfig,
  parseFanoutConfig,
  getFanoutConfig,
  getObservationCategories,
  getMedicationRequestStatus,
  getMedicationRequestStatuses,
  DEFAULT_OBSERVATION_CATEGORIES,
  DEFAULT_MEDICATION_REQUEST_STATUS,
  DEFAULT_MEDICATION_REQUEST_STATUSES,
  VALID_OBSERVATION_CATEGORIES,
  VALID_MEDICATION_REQUEST_STATUSES,
  type FanoutConfig,
  type FanoutConfigWarning,
  type ParsedFanoutConfig,
} from "./sync/fanout-config.js";
export {
  persistPatient,
  persistMedicationRequest,
  persistMedicationStatement,
  persistObservation,
  persistCondition,
  persistAllergy,
  type PersistResult,
} from "./sync/persistence.js";
export {
  startEpicSyncWorker,
  getEpicSyncQueue,
  enqueueFullSync,
  enqueueIncrementalSync,
  enqueueSingleResourceSync,
  summarise,
  SUMMARISE_SKIPPED_DETAIL_CAP,
  EPIC_SYNC_QUEUE_NAME,
  type EpicSyncJobData,
  type SyncSummary,
} from "./workers/sync-worker.js";
export { epicSyncRouter, type EpicSyncRouter } from "./router.js";
export {
  generatePkcePair,
  verifyChallenge,
  type PkcePair,
} from "./app-launch/pkce.js";
export {
  buildAuthorizeUrl,
  DEFAULT_APP_LAUNCH_SCOPES,
  type AuthorizeUrlArgs,
} from "./app-launch/authorize.js";
export {
  exchangeAuthorizationCode,
  decodeIdTokenUnsafe,
  extractPractitionerId,
  type AppLaunchTokenResponse,
  type ExchangeArgs,
} from "./app-launch/token-exchange.js";
export {
  InMemoryLaunchStateStore,
  RedisLaunchStateStore,
  type LaunchStateStore,
  type LaunchState,
  type RedisLike,
} from "./app-launch/state-store.js";
export {
  beginLaunch,
  completeLaunch,
  type BeginLaunchArgs,
  type BeginLaunchResult,
  type CompleteLaunchArgs,
  type CompleteLaunchResult,
} from "./app-launch/launch-service.js";
export {
  upsertEpicConnection,
  getConnectionsForUser,
  getConnection,
  deleteConnection,
  type EpicConnectionUpsert,
  type EpicConnectionRow,
} from "./app-launch/connection-repo.js";
export {
  buildFhirFlag,
  flagSeverityCoding,
  mapFlagStatusToFhir,
  CAREBRIDGE_FLAG_SEVERITY_SYSTEM,
  FHIR_FLAG_CATEGORY_SYSTEM,
  RATIONALE_EXTENSION_URL,
  SUGGESTED_ACTION_EXTENSION_URL,
  RULE_ID_EXTENSION_URL,
  type FhirFlag,
  type BuildFhirFlagArgs,
} from "./outbound/flag-generator.js";
export {
  pushFlagToEpic,
  pushFlagStatusUpdate,
  type FlagPushDeps,
  type FlagPushResult,
} from "./outbound/flag-push.js";
export {
  startEpicOutboundFlagWorker,
  enqueueEpicFlagPushCreate,
  enqueueEpicFlagPushUpdate,
  isEpicOutboundEnabled,
  EPIC_OUTBOUND_FLAGS_QUEUE_NAME,
  type EpicOutboundFlagJobData,
} from "./workers/outbound-flag-worker.js";
