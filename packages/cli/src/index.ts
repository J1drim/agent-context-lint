/** Stable public package identifier. */
export const packageId = "@agent-context/lint" as const;

export {
  LIBRARY_API_CONTRACT_VERSION,
  LIBRARY_API_LIMITS,
  LIBRARY_PROGRESS_KIND,
  LIBRARY_SCAN_CAPABILITY_KIND,
  LIBRARY_SCAN_REQUEST_KIND,
  LibraryApiError,
  LibraryApiErrorCode,
  createLibraryScanCapability,
  isIssuedLibraryScanCapability,
  isLibraryApiError,
  scanAgentContext,
} from "./library-api.js";
export type {
  LibraryApiErrorCategory,
  LibraryApiErrorCode as LibraryApiErrorCodeType,
  LibraryApiLimits,
  LibraryProgressObserver,
  LibraryProgressState,
  LibraryScanCapability,
  LibraryScanExecutionContext,
  LibraryScanExecutionResult,
  LibraryScanExecutor,
  LibraryScanOptions,
  LibraryScanProgress,
  LibraryScanRequest,
} from "./library-api.js";
