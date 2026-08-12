/** Internal standards knowledge and verification package. */
export const packageId = "@agent-context/standards" as const;

export {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_MATCHER_IDS,
  KNOWLEDGE_PACK_CHANNELS,
  KNOWLEDGE_PACK_CONTRACT_VERSION,
  KNOWLEDGE_VALUE_TYPES,
  LOCATION_SCOPES,
  MAX_KNOWLEDGE_COMPATIBILITY_RECORDS,
  MAX_KNOWLEDGE_PACK_BYTES,
  MAX_KNOWLEDGE_PACK_CONTAINER_ENTRIES,
  MAX_KNOWLEDGE_PACK_DEPTH,
  MAX_KNOWLEDGE_PACK_ISSUES,
  MAX_KNOWLEDGE_PACK_RECORDS,
  MAX_KNOWLEDGE_PACK_RULE_IDS,
  MAX_KNOWLEDGE_PACK_SOURCES,
  MAX_KNOWLEDGE_PACK_STRING_BYTES,
  MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS,
  MAX_KNOWLEDGE_PACK_TOTAL_STRING_BYTES,
  MAX_KNOWLEDGE_PACK_VALUES,
  canonicalizeJson,
  parseCanonicalKnowledgePack,
  serializeKnowledgePack,
  validateKnowledgePack,
} from "./knowledge-pack.js";
export type {
  CanonicalJsonResult,
  DeprecationKnowledge,
  FieldKnowledge,
  KnowledgeMatcher,
  KnowledgeMatcherId,
  KnowledgePack,
  KnowledgePackChannel,
  KnowledgePackIssue,
  KnowledgePackIssueCode,
  KnowledgePackParseResult,
  KnowledgePackSource,
  KnowledgePackValidationResult,
  KnowledgeRecord,
  KnowledgeValueType,
  LocationKnowledge,
  LocationScope,
  MigrationKnowledge,
  StandardsCompatibility,
} from "./knowledge-pack.js";

export {
  MAX_TUF_JSON_DEPTH,
  MAX_TUF_JSON_VALUES,
  MAX_TUF_ISSUE_MESSAGE_BYTES,
  MAX_TUF_ISSUE_PATH_BYTES,
  MAX_TUF_METADATA_BYTES,
  MAX_TUF_PACK_ID_BYTES,
  MAX_TUF_ROOT_CHAIN,
  MAX_TUF_SEMVER_BYTES,
  MAX_TUF_TARGET_BYTES,
  MAX_TUF_TARGET_PATH_BYTES,
  OfflineTufTrustStore,
  TUF_CLOCK_SKEW_MS,
  TUF_PREVIEW_ROLE,
  TUF_REPOSITORY_ID,
  TUF_SPECIFICATION_VERSION,
  TUF_STABLE_ROLE,
  TUF_SUPPORTED_KEY_SCHEME,
  TUF_SUPPORTED_KEY_TYPE,
  TUF_TRUST_CONTRACT_VERSION,
} from "./tuf-trust.js";

export {
  MAX_STANDARDS_REGISTRY_CONCURRENT_REQUESTS,
  MAX_STANDARDS_REGISTRY_HEADER_BYTES,
  MAX_STANDARDS_REGISTRY_HEADERS,
  STANDARDS_REGISTRY_BODY_TIMEOUT_MS,
  STANDARDS_REGISTRY_CLEANUP_TIMEOUT_MS,
  STANDARDS_REGISTRY_CONNECT_TIMEOUT_MS,
  STANDARDS_REGISTRY_CONTRACT_VERSION,
  STANDARDS_REGISTRY_DNS_TIMEOUT_MS,
  STANDARDS_REGISTRY_HEADERS_TIMEOUT_MS,
  STANDARDS_REGISTRY_OVERALL_TIMEOUT_MS,
  STANDARDS_REGISTRY_TLS_TIMEOUT_MS,
  StandardsRegistryClient,
} from "./registry-client.js";

export {
  MAX_STANDARDS_CHECK_REQUESTS,
  STANDARDS_CHECK_CONTRACT_VERSION,
  StandardsChecker,
} from "./standards-check.js";
export type {
  StandardsCheckIssue,
  StandardsCheckLocalIssueCode,
  StandardsCheckOptions,
  StandardsCheckPhase,
  StandardsCheckReport,
  StandardsCheckRequest,
  StandardsCheckResult,
} from "./standards-check.js";
export type {
  StandardsRegistryIssue,
  StandardsRegistryIssueCode,
  StandardsRegistryMetadataRole,
  StandardsRegistryObject,
  StandardsRegistryObjectRequest,
  StandardsRegistryProvenance,
  StandardsRegistryRequestOptions,
  StandardsRegistryResult,
} from "./registry-client.js";

export {
  BUNDLED_MANIFEST_LENGTH,
  BUNDLED_MANIFEST_SHA256,
  BUNDLED_PACK_LOADER_CONTRACT_VERSION,
  BUNDLED_PACK_MANIFEST_VERSION,
  getAuthenticatedBundledTrustStore,
  MAX_BUNDLED_MANIFEST_BYTES,
  MAX_BUNDLED_MANIFEST_ENTRIES,
  MAX_BUNDLED_PATH_BYTES,
  isAuthenticatedBundledKnowledgePack,
  loadBundledKnowledgePack,
} from "./bundled-pack-loader.js";

export {
  MAX_STANDARDS_CACHE_LOCK_ATTEMPTS,
  MAX_STANDARDS_CACHE_LOCK_DELAY_MS,
  MAX_STANDARDS_CACHE_LOCK_WAIT_MS,
  MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES,
  MAX_STANDARDS_CACHE_RELEASE_CLAIMS,
  STANDARDS_CACHE_CONTRACT_VERSION,
  STANDARDS_CACHE_LAYOUT_VERSION,
  StandardsCache,
} from "./standards-cache.js";
export type {
  StandardsCacheCandidate,
  StandardsCacheEntry,
  StandardsCacheEntryKind,
  StandardsCacheEntryRequest,
  StandardsCacheIssue,
  StandardsCacheIssueCode,
  StandardsCacheLockOptions,
  StandardsCacheQuarantineRecord,
  StandardsCacheResult,
  StandardsCacheWriteLock,
} from "./standards-cache.js";
export type {
  BundledKnowledgePackProvenance,
  BundledKnowledgePackRequest,
  BundledPackLoadIssue,
  BundledPackLoadIssueCode,
  BundledPackLoadResult,
  LoadedBundledKnowledgePack,
} from "./bundled-pack-loader.js";
export type {
  TufChannel,
  TufMetadataRole,
  TufOfflineUpdateBundle,
  TufOfflineUpdateRequest,
  TufTrustErrorCode,
  TufTrustIssue,
  TufTrustResult,
  TufTrustedMetadataSummary,
  TufTrustedStateSnapshot,
  TufVerifiedTarget,
  TufVerifiedUpdate,
} from "./tuf-trust.js";

export {
  DEFAULT_STANDARDS_LOCKFILE_PATH,
  MAX_STANDARDS_LOCKFILE_BYTES,
  STANDARDS_LOCKFILE_CONTRACT_VERSION,
  STANDARDS_LOCKFILE_RECORD_KIND,
  parseCanonicalStandardsLockfile,
  serializeStandardsLockfile,
  updateStandardsLockfile,
  validateStandardsLockfile,
} from "./standards-lockfile.js";
export type {
  StandardsLockfile,
  StandardsLockfileAtomicWriteRequest,
  StandardsLockfileAtomicWriteResult,
  StandardsLockfileAtomicWriter,
  StandardsLockfileExpectedState,
  StandardsLockfileIssue,
  StandardsLockfileIssueCode,
  StandardsLockfilePack,
  StandardsLockfileParseResult,
  StandardsLockfileSerializationResult,
  StandardsLockfileUpdateRequest,
  StandardsLockfileValidationResult,
} from "./standards-lockfile.js";

export {
  MAX_OFFLINE_STANDARDS_STATUS_ISSUES,
  MAX_STANDARDS_MAX_AGE_DAYS,
  MIN_STANDARDS_MAX_AGE_DAYS,
  OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION,
  OFFLINE_STANDARDS_STATUS_RECORD_KIND,
  createOfflineStandardsStatus,
} from "./offline-standards-status.js";

export {
  STANDARDS_ROLLBACK_RECEIPT_RECORD_KIND,
  STANDARDS_UPDATE_CONTRACT_VERSION,
  STANDARDS_UPDATE_RECORD_KIND,
  StandardsUpdater,
  rollbackStandardsUpdate,
} from "./standards-update.js";
export type {
  StandardsActivationOptions,
  StandardsActivationReport,
  StandardsRollbackReceipt,
  StandardsRollbackReport,
  StandardsUpdateDiff,
  StandardsUpdateIssue,
  StandardsUpdateIssueSource,
  StandardsUpdateLocalIssueCode,
  StandardsUpdatePlan,
  StandardsUpdateRequest,
  StandardsUpdateResult,
  StandardsUpdateSignerEvidence,
} from "./standards-update.js";
export type {
  OfflineStandardsArtifactAge,
  OfflineStandardsCachedLatestObservation,
  OfflineStandardsStatusIssue,
  OfflineStandardsStatusIssueCode,
  OfflineStandardsStatusIssueSource,
  OfflineStandardsStatusReport,
  OfflineStandardsStatusRequest,
  OfflineStandardsStatusResult,
} from "./offline-standards-status.js";
