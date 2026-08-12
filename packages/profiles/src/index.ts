/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/profiles" as const;

export {
  PROFILE_GLOB_DIALECT_CONTRACT_VERSION,
  PROFILE_GLOB_DIALECT_IDS,
  PROFILE_GLOB_DIALECTS,
  profileGlobDialect,
} from "./glob-dialects.js";
export type {
  ProfileGlobBracketState,
  ProfileGlobDialect,
  ProfileGlobDialectId,
  ProfileGlobFeatureState,
  ProfileGlobPatternBase,
} from "./glob-dialects.js";

export {
  CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES,
  CODEX_CLI_DEFAULT_PROJECT_ROOT_MARKERS,
  CODEX_CLI_PROFILE,
  CODEX_CLI_PROFILE_CONTRACT_VERSION,
  CODEX_CLI_PROFILE_ID,
  CODEX_CLI_SPEC_SNAPSHOT_ID,
  CODEX_CLI_SURFACE_ID,
} from "./codex-cli.js";
export type { CodexCliProfileDescriptor } from "./codex-cli.js";

export {
  COPILOT_PROFILE_CONTRACT_VERSION,
  COPILOT_PROFILE_FORMAT_IDS,
  COPILOT_PROFILE_IDS,
  COPILOT_PROFILES,
  COPILOT_SURFACE_IDS,
  copilotProfile,
} from "./copilot.js";

export {
  CURSOR_GLOB_DIALECT_ID,
  CURSOR_PROFILE_CONTRACT_VERSION,
  CURSOR_PROFILE_ID,
  CURSOR_SPEC_SNAPSHOT_ID,
  CURSOR_SURFACE_IDS,
  CURSOR_SURFACE_PROFILES,
  cursorSurfaceProfile,
} from "./cursor.js";
export type {
  CursorFormatClaim,
  CursorFormatId,
  CursorFormatSupport,
  CursorSurfaceId,
  CursorSurfaceProfileDescriptor,
  CursorVersionBoundary,
} from "./cursor.js";

export {
  CLAUDE_CODE_PROFILE,
  CLAUDE_CODE_PROFILE_CONTRACT_VERSION,
  CLAUDE_CODE_PROFILE_ID,
  CLAUDE_CODE_RULE_GLOB_DIALECT_ID,
  CLAUDE_CODE_SPEC_SNAPSHOT_ID,
  CLAUDE_CODE_SURFACE_ID,
} from "./claude-code.js";
export type { ClaudeCodeProfileDescriptor, ClaudeCodeVersionBoundary } from "./claude-code.js";

export {
  GEMINI_CLI_DEFAULT_CONTEXT_FILENAMES,
  GEMINI_CLI_DEFAULT_MEMORY_BOUNDARY_MARKERS,
  GEMINI_CLI_PROFILE,
  GEMINI_CLI_PROFILE_CONTRACT_VERSION,
  GEMINI_CLI_PROFILE_ID,
  GEMINI_CLI_SPEC_SNAPSHOT_ID,
  GEMINI_CLI_SURFACE_ID,
} from "./gemini-cli.js";
export type { GeminiCliProfileDescriptor } from "./gemini-cli.js";
export type {
  CopilotActivationMechanism,
  CopilotFormatProfileClaim,
  CopilotProfileDescriptor,
  CopilotProfileFormatId,
  CopilotProfileId,
  CopilotProfileSupport,
  CopilotProfileUncertainty,
  CopilotReferenceBehavior,
  CopilotSurfaceId,
} from "./copilot.js";
