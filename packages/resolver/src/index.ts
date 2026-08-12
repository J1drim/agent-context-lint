/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/resolver" as const;

export * from "./canonical-policy-sync.js";

export {
  ACTIVATION_ALGEBRA_LIMITS,
  ACTIVATION_PROVENANCE_KINDS,
  ACTIVATION_STATES,
  ActivationAlgebraError,
  ActivationAlgebraErrorCode,
  activationComplement,
  activationDifference,
  activationFact,
  activationIntersection,
  activationUnion,
  evaluateActivationRule,
  serializeActivationResult,
} from "./activation-algebra.js";
export type {
  ActivationAlgebraLimits,
  ActivationCallbacks,
  ActivationEvaluationInput,
  ActivationFactDecision,
  ActivationProvenance,
  ActivationProvenanceKind,
  ActivationResult,
  ActivationState,
  ConditionalActivationRequest,
  GlobActivationRequest,
  ManualActivationRequest,
} from "./activation-algebra.js";

export {
  PROFILE_GLOB_DIALECT_LIMITS,
  ProfileGlobDialectError,
  ProfileGlobDialectErrorCode,
  createProfileGlobActivationCallbacks,
  matchProfileGlob,
} from "./profile-glob-dialects.js";

export {
  CODEX_CLI_RESOLVER_CONTRACT_VERSION,
  CODEX_CLI_RESOLVER_LIMITS,
  CodexCliProfileError,
  CodexCliProfileErrorCode,
  createCodexCliFallbackDiscoveryMatcherFacts,
  isIssuedCodexCliAgentsResolution,
  resolveCodexCliAgents,
} from "./codex-cli-profile.js";
export type {
  CodexCliAgentsResolution,
  CodexCliCandidateDecision,
  CodexCliCandidateDecisionState,
  CodexCliContribution,
  CodexCliDiscoveryDecision,
  CodexCliDiscoverySnapshot,
  CodexCliEffectiveSettings,
  CodexCliExternalContext,
  CodexCliGlobalContextDecision,
  CodexCliProfileErrorCode as CodexCliProfileErrorCodeType,
  CodexCliProfileIssue,
  CodexCliProfileIssueCode,
  CodexCliRepositoryEntryKind,
  CodexCliRepositoryEntrySnapshot,
  CodexCliResolverLimits,
  CodexCliRootDecision,
  CodexCliSelectedDocument,
  CodexCliSelectionState,
  ResolveCodexCliAgentsInput,
} from "./codex-cli-profile.js";
export type {
  ProfileGlobDialectErrorCode as ProfileGlobDialectErrorCodeType,
  ProfileGlobDialectLimits,
} from "./profile-glob-dialects.js";

export {
  RESOLUTION_EVENT_TRACE_CONTRACT_VERSION,
  RESOLUTION_EVENT_TRACE_LIMITS,
  ResolutionEventTraceError,
  ResolutionEventTraceErrorCode,
  createResolutionEventTrace,
  createSyntheticTargetTrace,
  createTraceActivationCallbacks,
  digestResolutionEventTrace,
  normalizeResolutionEventTrace,
  resolveTraceRuleSelection,
  resolveTraceSetting,
  serializeResolutionEventTrace,
} from "./resolution-event-trace.js";

export {
  CURSOR_PROFILE_RESOLVER_CONTRACT_VERSION,
  CURSOR_PROFILE_RESOLVER_LIMITS,
  CursorProfileError,
  CursorProfileErrorCode,
  isIssuedCursorProfileResolution,
  resolveCursorProfile,
} from "./cursor-profile.js";
export type {
  CursorActivationChannels,
  CursorActivationState,
  CursorAgentSelectionRuntimeEvent,
  CursorCandidateDecision,
  CursorChannelState,
  CursorDiscoveryState,
  CursorEligibilityState,
  CursorExternalContextState,
  CursorManualRuntimeEvent,
  CursorPathRuntimeEvent,
  CursorProfileDecisionCode,
  CursorProfileErrorCode as CursorProfileErrorCodeType,
  CursorProfileResolution,
  CursorProfileResolverLimits,
  CursorProjectRulesSetting,
  CursorReferenceDecision,
  CursorRuleCandidateSnapshot,
  CursorRuntimeEvent,
  CursorRuntimeEventState,
  CursorRuntimeSnapshot,
  CursorSelectionState,
  CursorTargetDecision,
  CursorVersionState,
  ResolveCursorProfileInput,
} from "./cursor-profile.js";

export {
  TARGET_SAMPLER_CONTRACT_VERSION,
  TARGET_SAMPLER_DEFAULT_LIMITS,
  TARGET_SAMPLER_HARD_LIMITS,
  TARGET_SAMPLER_MAX_PATH_CODE_UNITS,
  TargetSamplerError,
  TargetSamplerErrorCode,
  classifyTargetSourcePath,
  isIssuedTargetSamplingResult,
  sampleTargets,
} from "./target-sampler.js";
export type {
  SampleTargetsInput,
  SampledTarget,
  TargetActivationFact,
  TargetActivationObservation,
  TargetCoverageCriterion,
  TargetCoverageKind,
  TargetSamplerClock,
  TargetSamplerErrorCode as TargetSamplerErrorCodeType,
  TargetSamplerLimits,
  TargetSamplerOptions,
  TargetSamplingMetrics,
  TargetSamplingProvenance,
  TargetSamplingResult,
  TargetSourceLanguage,
} from "./target-sampler.js";

export {
  DOCUMENT_IMPORT_DAG_CONTRACT_VERSION,
  DOCUMENT_IMPORT_DAG_LIMITS,
  DocumentImportDagError,
  DocumentImportDagErrorCode,
  buildDocumentImportDag,
  buildNoImportDocumentDag,
  isIssuedDocumentImportDag,
} from "./document-import-dag.js";
export type {
  BuildDocumentImportDagInput,
  BuildNoImportDocumentDagInput,
  DocumentImportDag,
  ImportDagContent,
  ImportDagDocument,
  ImportDagIssue,
  ImportDagOccurrence,
  ImportDagOccurrenceState,
} from "./document-import-dag.js";
export type {
  ResolutionEventTrace,
  ResolutionEventTraceLimits,
  SyntheticTargetTraceInput,
  TraceActivationRuleDescriptor,
  TraceRuleSelection,
  TraceRuleSelectionEvidence,
  TraceRuleSelectionQuery,
  TraceSettingQuery,
  TraceSettingResult,
} from "./resolution-event-trace.js";

export {
  COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION,
  COPILOT_PROFILE_RESOLVER_LIMITS,
  CopilotProfileError,
  CopilotProfileErrorCode,
  isIssuedCopilotProfileResolution,
  resolveCopilotProfile,
} from "./copilot-profile.js";

export {
  INSTRUCTION_LIST_CONTRACT_VERSION,
  INSTRUCTION_LIST_LIMITS,
  InstructionListError,
  buildInstructionList,
} from "./instruction-list.js";
export type {
  BuildInstructionListInput,
  GeminiInstructionListSource,
  InstructionListEntry,
  InstructionListResult,
  InstructionListState,
  InstructionListSummary,
} from "./instruction-list.js";

export {
  CLAUDE_CODE_PROFILE_LIMITS,
  CLAUDE_CODE_PROFILE_RESOLVER_CONTRACT_VERSION,
  ClaudeCodeProfileError,
  ClaudeCodeProfileErrorCode,
  isIssuedClaudeCodeProfileResolution,
  resolveClaudeCodeProfile,
} from "./claude-code-profile.js";
export type {
  ClaudeCandidateDecision,
  ClaudeCandidateKind,
  ClaudeCandidateOrigin,
  ClaudeCodeProfileErrorCode as ClaudeCodeProfileErrorCodeType,
  ClaudeCodeProfileResolution,
  ClaudeExclusionSnapshot,
  ClaudeImportDecision,
  ClaudeInstructionCandidateSnapshot,
  ClaudeLoadState,
  ClaudeProfileDecisionCode,
  ClaudeRuntimeEvent,
  ClaudeRuntimeSnapshot,
  ClaudeSettingSourcesSnapshot,
  ClaudeSymlinkState,
  ResolveClaudeCodeProfileInput,
} from "./claude-code-profile.js";

export {
  GEMINI_CLI_RESOLVER_CONTRACT_VERSION,
  GEMINI_CLI_RESOLVER_LIMITS,
  GeminiCliProfileError,
  isIssuedGeminiCliResolution,
  resolveGeminiCliContext,
} from "./gemini-cli-profile.js";
export type {
  GeminiCliCandidateKind,
  GeminiCliCandidateSnapshot,
  GeminiCliDocumentDecision,
  GeminiCliEventDecision,
  GeminiCliEventKind,
  GeminiCliEventSnapshot,
  GeminiCliIssue,
  GeminiCliIssueCode,
  GeminiCliResolution,
  GeminiCliResolverLimits,
  ResolveGeminiCliInput,
} from "./gemini-cli-profile.js";
export type {
  CopilotActivationState,
  CopilotCandidateDecision,
  CopilotCliRuntimeSnapshot,
  CopilotCliStandardLocation,
  CopilotCloudAgentRuntimeSnapshot,
  CopilotCodeReviewRuntimeSnapshot,
  CopilotDiscoveryState,
  CopilotEligibilityState,
  CopilotInstructionCandidateSnapshot,
  CopilotProfileDecisionCode,
  CopilotProfileErrorCode as CopilotProfileErrorCodeType,
  CopilotProfileResolution,
  CopilotProfileResolverLimits,
  CopilotRuntimeEventState,
  CopilotRuntimeSettingState,
  CopilotRuntimeSnapshot,
  CopilotTargetDecision,
  CopilotVscodeInstructionFolder,
  CopilotVscodeRuntimeSnapshot,
  ResolveCopilotProfileInput,
} from "./copilot-profile.js";

export {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_LIMITS,
  EFFECTIVE_CONTEXT_RECORD_KIND,
  EffectiveContextError,
  EffectiveContextErrorCode,
  isIssuedEffectiveContextResolution,
  resolveEffectiveContext,
} from "./effective-context.js";

export {
  EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_CACHE_DEFAULT_LIMITS,
  EFFECTIVE_CONTEXT_CACHE_HARD_LIMITS,
  EFFECTIVE_CONTEXT_CACHE_KEY_RECORD_KIND,
  EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
  EffectiveContextCacheError,
  EffectiveContextCacheErrorCode,
  EffectiveContextMemoizationCache,
} from "./effective-context-cache.js";
export type {
  EffectiveContextCacheDocumentSnapshot,
  EffectiveContextCacheErrorCode as EffectiveContextCacheErrorCodeType,
  EffectiveContextCacheKey,
  EffectiveContextCacheLimits,
  EffectiveContextCacheOptions,
  EffectiveContextCacheRequest,
  EffectiveContextCacheResolveOptions,
  EffectiveContextCacheStats,
} from "./effective-context-cache.js";

export {
  EXPLAIN_PROJECTION_CONTRACT_VERSION,
  EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
  EXPLAIN_PROJECTION_LIMITS,
  EXPLAIN_PROJECTION_RECORD_KIND,
  ExplainProjectionError,
  ExplainProjectionErrorCode,
  projectExplain,
} from "./explain-projection.js";
export type {
  ExplainAccounting,
  ExplainDisposition,
  ExplainDocument,
  ExplainOccurrence,
  ExplainProjection,
  ExplainProjectionErrorCode as ExplainProjectionErrorCodeType,
  ExplainReason,
  ExplainReasonKind,
  ExplainTargetProjection,
  ExplainTraceEvent,
  ProjectExplainInput,
} from "./explain-projection.js";
export type {
  EffectiveContentState,
  EffectiveContextAmbiguity,
  EffectiveContextAmbiguityKind,
  EffectiveContextAssembly,
  EffectiveContextConflictOpportunity,
  EffectiveContextDocument,
  EffectiveContextOccurrence,
  EffectiveContextPrecedence,
  EffectiveContextProfileResolution,
  EffectiveContextResolution,
  EffectiveDocumentActivation,
  EffectiveDocumentState,
  ResolveEffectiveContextInput,
} from "./effective-context.js";

export {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  CROSS_PROFILE_COMPARISON_LIMITS,
  CROSS_PROFILE_COMPARISON_RECORD_KIND,
  CrossProfileComparisonError,
  CrossProfileComparisonErrorCode,
  compareEffectiveContexts,
  isIssuedCrossProfileComparison,
} from "./cross-profile-comparison.js";

export {
  BOUNDED_RESOLUTION_CONTRACT_VERSION,
  BOUNDED_RESOLUTION_DEFAULT_LIMITS,
  BOUNDED_RESOLUTION_HARD_LIMITS,
  BOUNDED_RESOLUTION_RECORD_KIND,
  BoundedResolutionError,
  BoundedResolutionErrorCode,
  createEffectiveContextResolutionTask,
  isIssuedBoundedResolutionResult,
  resolveEffectiveContextsBounded,
} from "./bounded-resolution.js";
export type {
  BoundedResolutionEntry,
  BoundedResolutionErrorCode as BoundedResolutionErrorCodeType,
  BoundedResolutionLimits,
  BoundedResolutionOptions,
  BoundedResolutionResult,
  EffectiveContextResolutionExecutor,
  EffectiveContextResolutionTask,
  EffectiveContextResolutionTaskDescriptor,
} from "./bounded-resolution.js";
export type {
  CompareEffectiveContextsInput,
  CrossProfileComparison,
  CrossProfileComparisonErrorCode as CrossProfileComparisonErrorCodeType,
  CrossProfileContentComparison,
  CrossProfileContentDifference,
  CrossProfileCountSummary,
  CrossProfileDimensionState,
  CrossProfileOrderComparison,
  CrossProfileOrderWitness,
  CrossProfilePairComparison,
  CrossProfileProfileSummary,
  CrossProfileScopeComparison,
  CrossProfileScopeDifference,
  CrossProfileScopeState,
} from "./cross-profile-comparison.js";
