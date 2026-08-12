/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/formatters" as const;

export {
  JSON_FORMATTER_DEFAULT_CHUNK_BYTES,
  JSON_FORMATTER_MAX_CHUNK_BYTES,
  JSON_FORMATTER_MAX_OUTPUT_BYTES,
  JSON_FORMATTER_MAX_PROFILE_VERSIONS,
  JSON_FORMATTER_MIN_CHUNK_BYTES,
  formatJsonDiagnostics,
  writeJsonDiagnostics,
} from "./json.js";
export type {
  JsonChunkSink,
  JsonFormatterFailureThreshold,
  JsonFormatterIssue,
  JsonFormatterOptions,
  JsonFormatterResult,
  JsonFormatterWriteResult,
} from "./json.js";

export {
  MAX_STYLISH_RELATED_LOCATIONS,
  STYLISH_CELL_WIDTH_VERSION,
  STYLISH_DEFAULT_WIDTH,
  STYLISH_MAX_WIDTH,
  STYLISH_MIN_WIDTH,
  formatStylishDiagnostics,
  measureStylishTextWidth,
} from "./stylish.js";
export type {
  StylishColorPolicy,
  StylishFailureThreshold,
  StylishFormatterIssue,
  StylishFormatterOptions,
  StylishFormatterResult,
} from "./stylish.js";

export {
  MAX_SARIF_FORMATTER_OUTPUT_BYTES,
  computeGithubPrimaryLocationLineHashes,
  formatSarifDiagnostics,
} from "./sarif.js";
export type { SarifFormatterIssue, SarifFormatterOptions, SarifFormatterResult } from "./sarif.js";
