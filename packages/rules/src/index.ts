/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/rules" as const;

export {
  REFERENCE_SEMANTIC_PLUGIN_DESCRIPTOR,
  REFERENCE_SEMANTIC_PLUGIN_ID,
  REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256,
  SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND,
  SEMANTIC_PLUGIN_CONTRACT_VERSION,
  SEMANTIC_PLUGIN_DEFAULT_LIMITS,
  SEMANTIC_PLUGIN_DISABLED_CONFIGURATION,
  SEMANTIC_PLUGIN_HARD_LIMITS,
  SEMANTIC_PLUGIN_INPUT_RECORD_KIND,
  SEMANTIC_PLUGIN_RESULT_RECORD_KIND,
  getReferenceSemanticPluginModuleBytes,
  runSemanticRulePlugin,
} from "./semantic-plugin.js";
export type {
  SemanticPluginCapability,
  SemanticPluginConfiguration,
  SemanticPluginDescriptor,
  SemanticPluginDocument,
  SemanticPluginFinding,
  SemanticPluginId,
  SemanticPluginInput,
  SemanticPluginIssue,
  SemanticPluginIssueCode,
  SemanticPluginLimits,
  SemanticPluginOptions,
  SemanticPluginResult,
  SemanticPluginSuccess,
} from "./semantic-plugin.js";

export {
  CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RULE_DEFAULT_THRESHOLDS,
  CONTEXT_EFFICIENCY_RULE_HARD_MAXIMUM_THRESHOLD,
  CONTEXT_EFFICIENCY_RULE_IDS,
  CONTEXT_EFFICIENCY_RULE_MAX_COMPARISONS,
  CONTEXT_EFFICIENCY_RULE_VERSION,
  evaluateContextEfficiencyRules,
  finalizeContextEfficiencySuppressions,
} from "./context-efficiency.js";
export type {
  ContextEfficiencyRuleId,
  ContextEfficiencyRuleInput,
  ContextEfficiencyRuleIssue,
  ContextEfficiencyRuleIssueCode,
  ContextEfficiencyRuleMetrics,
  ContextEfficiencyRuleOptions,
  ContextEfficiencyRuleResult,
  ContextEfficiencyRuleThresholds,
  ContextEfficiencySuppressionFinalizationResult,
  ContextEfficiencyUncertainty,
  ContextEfficiencyUncertaintyReason,
  EfficiencyTokenizerComparisonInput,
} from "./context-efficiency.js";

export {
  MAX_RULE_METADATA_TEXT_BYTES,
  MAX_RULE_METADATA_TEXT_CODE_POINTS,
  MAX_RULE_REGISTRY_ISSUES,
  MAX_RULES_PER_REGISTRY,
  REQUIRED_RULE_IDS,
  RULE_CATEGORIES,
  RULE_DEFAULT_SEVERITIES,
  RULE_FIX_SAFETY_LEVELS,
  RULE_OWNER_ALIASES,
  RULE_PRECISION_STATUSES,
  RULE_REGISTRY,
  RULE_REGISTRY_VERSION,
  findRuleMetadata,
  isRuleRegistry,
  renderRuleCatalogMarkdown,
  resolveRuleDocsUrl,
  validateRuleRegistry,
} from "./registry.js";
export { RULE_EXAMPLES, findRuleExample } from "./rule-examples.js";
export type { RuleExample } from "./rule-examples.js";
export type {
  RuleCategory,
  RuleDefaultSeverity,
  RuleFixSafety,
  RuleId,
  RuleMetadata,
  RuleOwnerAlias,
  RulePrecisionStatus,
  RuleRegistry,
  RuleRegistryValidationCode,
  RuleRegistryValidationIssue,
  RuleRegistryValidationResult,
} from "./registry.js";

export {
  REPOSITORY_DRIFT_CONTRACT_VERSION,
  REPOSITORY_DRIFT_DEFAULT_LIMITS,
  REPOSITORY_DRIFT_HARD_LIMITS,
  REPOSITORY_DRIFT_RULE_IDS,
  REPOSITORY_DRIFT_RULE_VERSION,
  RepositoryDriftError,
  RepositoryDriftErrorCode,
  evaluateRepositoryDrift,
} from "./repository-drift.js";
export type {
  RepositoryDriftEvidenceInput,
  RepositoryDriftLimits,
  RepositoryDriftMetrics,
  RepositoryDriftOptions,
  RepositoryDriftResult,
  RepositoryDriftRuleId,
  RepositoryDriftStatementInput,
  RepositoryDriftUncertainty,
  RepositoryDriftUncertaintyReason,
} from "./repository-drift.js";

export {
  DOCUMENT_CONTEXT_BUDGET_SCOPE,
  DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS,
  DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD,
  DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT,
  DOCUMENT_CONTEXT_RULE_CONTRACT_VERSION,
  DOCUMENT_CONTEXT_RULE_IDS,
  DOCUMENT_CONTEXT_RULE_VERSION,
  evaluateDocumentContextRules,
} from "./document-context.js";

export {
  REFERENCE_MARKDOWN_LINK_STATES,
  REFERENCE_PROFILE_IDS,
  REFERENCES_IMPORTS_CONTRACT_VERSION,
  REFERENCES_IMPORTS_DEFAULT_LIMITS,
  REFERENCES_IMPORTS_HARD_LIMITS,
  REFERENCES_IMPORTS_RULE_IDS,
  REFERENCES_IMPORTS_RULE_VERSION,
  ReferencesImportsError,
  ReferencesImportsErrorCode,
  evaluateReferencesImports,
} from "./references-imports.js";
export type {
  ReferenceMarkdownLinkState,
  ReferenceProfileId,
  ReferenceProfileTarget,
  ReferenceRepositoryPathSnapshot,
  ReferenceUncertainty,
  ReferenceUncertaintyReason,
  ReferencesImportsInput,
  ReferencesImportsLimits,
  ReferencesImportsMetrics,
  ReferencesImportsOptions,
  ReferencesImportsResult,
  ReferencesImportsRuleId,
} from "./references-imports.js";

export {
  SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION,
  SYNTAX_STRUCTURE_RULE_IDS,
  SYNTAX_STRUCTURE_RULE_VERSION,
  evaluateSyntaxStructureRules,
  finalizeScheduledSyntaxSuppressions,
  finalizeSyntaxSuppressions,
  getSyntaxSuppressionFinalizationIssuance,
  planApprovedMechanicalFixes,
} from "./syntax-structure.js";

export type {
  ApprovedMechanicalFixPlanResult,
  ApprovedMechanicalFixResult,
  FrontmatterFieldPolicy,
  FrontmatterValueType,
  SyntaxDocumentPolicy,
  SyntaxProfileObservation,
  SyntaxSpecEvidence,
  SyntaxStructureRuleId,
  SyntaxStructureRuleInput,
  SyntaxStructureRuleIssue,
  SyntaxStructureRuleMetrics,
  SyntaxStructureRuleResult,
  SyntaxSuppressionFinalizationResult,
  SyntaxSuppressionFinalizationIssuance,
} from "./syntax-structure.js";

export {
  MECHANICAL_FIX_SAFETY_CONTRACT_VERSION,
  MECHANICAL_FIX_SAFETY_MATRIX,
  MECHANICAL_FIX_SAFETY_REASONS,
  isMechanicalFixSafetyMatrix,
  renderMechanicalFixSafetyMarkdown,
  validateMechanicalFixSafetyMatrix,
} from "./mechanical-fix-safety.js";
export type {
  MechanicalFixSafetyDecision,
  MechanicalFixSafetyMatrix,
  MechanicalFixSafetyReason,
  MechanicalFixSafetyRule,
  MechanicalFixSafetyValidationIssue,
  MechanicalFixSafetyValidationResult,
} from "./mechanical-fix-safety.js";
export {
  STANDARDS_FRESHNESS_DEFAULT_LIMITS,
  STANDARDS_FRESHNESS_RULE_CONTRACT_VERSION,
  STANDARDS_FRESHNESS_RULE_IDS,
  STANDARDS_FRESHNESS_RULE_VERSION,
  evaluateStandardsFreshnessRules,
  finalizeStandardsFreshnessSuppressions,
} from "./standards-freshness.js";
export type {
  DeprecatedSyntaxObservation,
  StandardsFreshnessRuleId,
  StandardsFreshnessRuleInput,
  StandardsFreshnessRuleIssue,
  StandardsFreshnessRuleMetrics,
  StandardsFreshnessRuleResult,
  StandardsFreshnessSuppressionFinalizationResult,
  StandardsObservationOrigin,
  VerifiedLiveStandardsObservation,
} from "./standards-freshness.js";
export {
  SCOPE_ACTIVATION_CONTRACT_VERSION,
  SCOPE_ACTIVATION_DEFAULT_LIMITS,
  SCOPE_ACTIVATION_FACT_STATES,
  SCOPE_ACTIVATION_HARD_LIMITS,
  SCOPE_ACTIVATION_RULE_IDS,
  SCOPE_ACTIVATION_RULE_VERSION,
  SCOPE_ACTIVATION_TARGET_KINDS,
  ScopeActivationError,
  ScopeActivationErrorCode,
  evaluateScopeActivationRules,
} from "./scope-activation.js";
export type {
  ScopeActivationFactState,
  ScopeActivationInput,
  ScopeActivationLimits,
  ScopeActivationMetrics,
  ScopeActivationObservation,
  ScopeActivationObservationResult,
  ScopeActivationOptions,
  ScopeActivationResult,
  ScopeActivationRuleFact,
  ScopeActivationRuleId,
  ScopeActivationSamplingInput,
  ScopeActivationSetState,
  ScopeActivationSummary,
  ScopeActivationTargetKind,
  ScopeActivationUncertainty,
  ScopeActivationUncertaintyReason,
} from "./scope-activation.js";
export type {
  DocumentContextRuleInput,
  DocumentContextRuleId,
  DocumentContextRuleIssue,
  DocumentContextRuleMetrics,
  DocumentContextRuleOptions,
  DocumentContextRuleResult,
  DocumentContextRuleThresholds,
  DocumentImportResolution,
  ImportResolutionProvenance,
} from "./document-context.js";

export {
  SECURITY_RULE_CONTRACT_VERSION,
  SECURITY_RULE_DEFAULT_LIMITS,
  SECURITY_RULE_HARD_LIMITS,
  SECURITY_RULE_IDS,
  SECURITY_RULE_VERSION,
  evaluateSecurityRules,
  finalizeSecuritySuppressions,
} from "./security.js";

export {
  CONFLICTS_DUPLICATION_CONTRACT_VERSION,
  CONFLICTS_DUPLICATION_DEFAULT_LIMITS,
  CONFLICTS_DUPLICATION_HARD_LIMITS,
  CONFLICTS_DUPLICATION_RULE_IDS,
  CONFLICTS_DUPLICATION_RULE_VERSION,
  evaluateConflictsDuplicationRules,
  finalizeConflictsDuplicationSuppressions,
} from "./conflicts-duplication.js";
export type {
  ConflictsDuplicationInput,
  ConflictsDuplicationIssue,
  ConflictsDuplicationIssueCode,
  ConflictsDuplicationLimits,
  ConflictsDuplicationMetrics,
  ConflictsDuplicationOptions,
  ConflictsDuplicationResult,
  ConflictsDuplicationRuleId,
  ConflictsDuplicationSuppressionFinalizationResult,
  ConflictsDuplicationUncertainty,
  ConflictsDuplicationUncertaintyReason,
} from "./conflicts-duplication.js";

export {
  PORTABILITY_BEHAVIOR_KINDS,
  PORTABILITY_RULE_CONTRACT_VERSION,
  PORTABILITY_RULE_DEFAULT_LIMITS,
  PORTABILITY_RULE_HARD_LIMITS,
  PORTABILITY_RULE_IDS,
  PORTABILITY_RULE_VERSION,
  PORTABILITY_SUPPORT_STATES,
  evaluatePortabilityRules,
  finalizePortabilitySuppressions,
} from "./portability.js";
export type {
  PortabilityBehaviorKind,
  PortabilityBehaviorObservation,
  PortabilityFormatObservation,
  PortabilityRuleInput,
  PortabilityRuleIssue,
  PortabilityRuleIssueCode,
  PortabilityRuleLimits,
  PortabilityRuleMetrics,
  PortabilityRuleOptions,
  PortabilityRuleResult,
  PortabilityRuleId,
  PortabilitySupportState,
  PortabilitySuppressionFinalizationResult,
  PortabilityUncertainty,
  PortabilityUncertaintyReason,
} from "./portability.js";
export type {
  SecurityRuleId,
  SecurityRuleInput,
  SecurityRuleIssue,
  SecurityRuleIssueCode,
  SecurityRuleLimits,
  SecurityRuleMetrics,
  SecurityRuleOptions,
  SecurityRuleResult,
  SecurityRuleUncertainty,
  SecurityRuleUncertaintyReason,
  SecurityStatementDialect,
  SecuritySuppressionFinalizationResult,
} from "./security.js";

export {
  RULE_FAMILY_DESCRIPTORS,
  RULE_FAMILY_IDS,
  RULE_SCHEDULER_CONTRACT_VERSION,
  RULE_SCHEDULER_DEFAULT_LIMITS,
  RULE_SCHEDULER_HARD_LIMITS,
  RULE_SCHEDULER_RECORD_KIND,
  canonicalizeRuleDiagnostics,
  isIssuedRuleSchedulerSuccess,
  scheduleRuleFamilies,
} from "./rule-scheduler.js";

export {
  CHANGED_FILE_MODE_CONTRACT_VERSION,
  CHANGED_FILE_MODE_INPUT_KIND,
  CHANGED_FILE_MODE_LIMITS,
  CHANGED_FILE_MODE_RESULT_KIND,
  createChangedFileModeEvidenceAuthority,
  planChangedFileMode,
} from "./changed-file-mode.js";
export type {
  ChangedFileModeFallbackReason,
  ChangedFileModeEvidenceAuthority,
  ChangedFileModeInput,
  ChangedFileModeResult,
} from "./changed-file-mode.js";
export type {
  ConflictsDuplicationFamilyRequest,
  ContextEfficiencyFamilyRequest,
  DocumentContextFamilyRequest,
  PortabilityFamilyRequest,
  ReferencesImportsFamilyRequest,
  RepositoryDriftFamilyInput,
  RepositoryDriftFamilyRequest,
  RuleDiagnosticCanonicalizationResult,
  RuleFamilyDescriptor,
  RuleFamilyId,
  RuleFamilyRequest,
  RuleFamilySummary,
  RuleSchedulerFailureThreshold,
  RuleSchedulerInput,
  RuleSchedulerIssue,
  RuleSchedulerIssueCode,
  RuleSchedulerLimits,
  RuleSchedulerOptions,
  RuleSchedulerPolicy,
  RuleSchedulerResult,
  RuleSchedulerSeverity,
  RuleSchedulerSuccess,
  RuleSchedulerSummary,
  ScopeActivationFamilyRequest,
  SecurityFamilyRequest,
  StandardsFreshnessFamilyRequest,
  SyntaxStructureFamilyRequest,
} from "./rule-scheduler.js";
