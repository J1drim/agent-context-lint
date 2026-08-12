/** Internal workspace marker; this package is not a public consumer API. */
export const packageId = "@agent-context/efficiency" as const;

export { ESTIMATE_UTF8_BYTES_PER_TOKEN, countEstimatedTokens } from "./estimate-tokenizer.js";
export type { EstimateTokenCountResult } from "./estimate-tokenizer.js";

export {
  EXACT_TOKENIZER_DEFAULT_TIMEOUT_MS,
  EXACT_TOKENIZER_MAX_ARTIFACT_TEXT_BYTES,
  EXACT_TOKENIZER_MAX_TIMEOUT_MS,
  EXACT_TOKENIZER_MIN_TIMEOUT_MS,
  EXACT_TOKENIZER_TERMINATION_GRACE_MS,
  countTokensWithProvider,
} from "./exact-tokenizer.js";
export type {
  ExactTokenizerFallbackCode,
  ExactTokenizerIssue,
  ExactTokenizerOptions,
  SelectedTokenCount,
  SelectedTokenCountResult,
  TokenizerFallback,
} from "./exact-tokenizer.js";

export {
  BUILTIN_ESTIMATE_IDENTITY,
  BUILTIN_ESTIMATE_PROVIDER_ID,
  MAX_TOKENIZER_ID_BYTES,
  MAX_TOKENIZER_INPUT_BYTES,
  MAX_TOKENIZER_VERSION_BYTES,
  OPTIONAL_UTF8_BYTE_IDENTITY,
  OPTIONAL_UTF8_BYTE_PROVIDER_ID,
  TOKENIZER_MEASUREMENTS,
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
  compareTokenizerIdentities,
  resolveTokenizerProvider,
  validateTokenizerIdentity,
} from "./tokenizer-contract.js";

export {
  DEFAULT_EFFICIENCY_SCORE_SPECIFICATION,
  EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS,
  EFFICIENCY_DENSITY_TARGET_BASIS_POINTS,
  EFFICIENCY_SCORE_BASIS_POINTS,
  EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS,
  EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION,
  EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND,
  EFFICIENCY_SCORE_VERSION,
  EfficiencyScoreSpecificationError,
  EfficiencyScoreSpecificationErrorCode,
  createEfficiencyScoreSpecification,
  efficiencyRatioBasisPoints,
  evaluateEfficiencyPenaltyCurve,
  gradeEfficiencyScore,
  isSupportedEfficiencyScoreVersion,
} from "./efficiency-score-specification.js";
export type {
  EfficiencyGrade,
  EfficiencyGradeThresholds,
  EfficiencyMetricNormalization,
  EfficiencyScoreComponentSpecification,
  EfficiencyScoreInputSpecification,
  EfficiencyScoreSpecification,
  EfficiencyScoreSpecificationErrorCode as EfficiencyScoreSpecificationErrorCodeType,
  PenaltyCurve,
  PenaltyCurvePoint,
} from "./efficiency-score-specification.js";

export {
  OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION,
  OCCURRENCE_TOKEN_ACCOUNTING_LIMITS,
  OccurrenceTokenAccountingError,
  OccurrenceTokenAccountingErrorCode,
  accountOccurrenceTokens,
  combineOccurrenceTokenAccountings,
  isIssuedOccurrenceTokenAccounting,
} from "./occurrence-token-accounting.js";
export type {
  AccountOccurrenceTokensInput,
  CombineOccurrenceTokenAccountingsInput,
  ContentTokenContribution,
  DocumentTokenContribution,
  DocumentTokenMeasurement,
  OccurrenceActivation,
  OccurrenceDisposition,
  OccurrenceTokenAccounting,
  OccurrenceTokenAccountingErrorCode as OccurrenceTokenAccountingErrorCodeType,
  OccurrenceTokenContribution,
  OccurrenceTokenDecision,
  TokenAccountingIssue,
  TokenAccountingIssueCode,
  TokenAccountingTotals,
} from "./occurrence-token-accounting.js";

export {
  PROFILE_TARGET_DISTRIBUTION_CONTRACT_VERSION,
  PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS,
  PROFILE_TARGET_DISTRIBUTION_PERCENTILE_METHOD,
  ProfileTargetDistributionError,
  ProfileTargetDistributionErrorCode,
  aggregateProfileTargetDistribution,
} from "./profile-target-distribution.js";

export {
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_METRICS_LIMITS,
  CONTEXT_EFFICIENCY_METRICS_RECORD_KIND,
  CONTEXT_EFFICIENCY_RATIO_SCALE,
  ContextEfficiencyMetricsError,
  ContextEfficiencyMetricsErrorCode,
  analyzeContextEfficiencyMetrics,
  isIssuedContextEfficiencyMetrics,
} from "./context-efficiency-metrics.js";
export type {
  AmplificationStatistics,
  AmplificationTargetMetric,
  AnalyzeContextEfficiencyMetricsInput,
  BroadScopeDocumentMetric,
  ContextEfficiencyMetrics,
  ContextEfficiencyMetricsErrorCode as ContextEfficiencyMetricsErrorCodeType,
  CrossProfileDivergenceMetrics,
  CrossProfileDivergenceObservation,
  DeadScopeDocumentMetric,
  DensityMetrics,
  DensityStatementEvidence,
  DivergenceEvidenceKind,
  DivergencePathEvidence,
  DivergentExactPolicyMetric,
  DocumentDensityMetric,
  DuplicateMetrics,
  EfficiencyMetricDocumentInput,
  EfficiencyMetricProfileInput,
  EfficiencyMetricStatementInput,
  ExactDuplicateMetricCluster,
  MetricStatementContribution,
  MetricTokenContribution,
  MissingCrossProfileComparison,
  NearDuplicateMetricCluster,
  ProfileAmplificationMetric,
  ProfileBroadScopeMetric,
  ProfileDeadScopeMetric,
  ProfileMetricIdentity,
  TargetTokenContribution,
} from "./context-efficiency-metrics.js";
export type {
  AggregateProfileTargetDistributionInput,
  ProfileTargetAccounting,
  ProfileTargetDistribution,
  ProfileTargetDistributionErrorCode as ProfileTargetDistributionErrorCodeType,
  ProfileTargetDistributionIssue,
  ProfileTargetDistributionIssueCode,
  ProfileTargetIdentity,
  ProfileTargetTokenObservation,
  ProfileTargetTokenStatistics,
} from "./profile-target-distribution.js";
export type {
  ResolvedTokenizerProvider,
  TokenCount,
  TokenizerComparisonCompatibility,
  TokenizerContractIssue,
  TokenizerContractIssueCode,
  TokenizerIdentity,
  TokenizerIdentityValidationResult,
  TokenizerMeasurement,
  TokenizerProviderResolution,
} from "./tokenizer-contract.js";

export {
  CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_SCORE_RECORD_KIND,
  ContextEfficiencyScoreError,
  ContextEfficiencyScoreErrorCode,
  calculateContextEfficiencyScore,
  isIssuedContextEfficiencyScore,
} from "./context-efficiency-score.js";
export type {
  ContextEfficiencyScore,
  ContextEfficiencyScoreErrorCode as ContextEfficiencyScoreErrorCodeType,
  EfficiencyComponentScore,
  EfficiencyScoreCaveatCode,
  EfficiencyScoreConfidence,
  EfficiencyScoreEvidenceReference,
  EfficiencyScoreInputResult,
  EfficiencyScoreState,
  EfficiencyScoreUncertaintyCode,
} from "./context-efficiency-score.js";

export {
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_RECORD_KIND,
  ContextEfficiencyRecommendationsError,
  ContextEfficiencyRecommendationsErrorCode,
  isIssuedContextEfficiencyRecommendations,
} from "./context-efficiency-recommendations.js";
export { projectContextEfficiencyRecommendations } from "./context-efficiency-recommendations-full.js";

export {
  CONTEXT_EFFICIENCY_COMPARISON_RECORD_KIND,
  CONTEXT_EFFICIENCY_REPORT_LIMITS,
  CONTEXT_EFFICIENCY_REPORT_RECORD_KIND,
  CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION,
  ContextEfficiencyReportError,
  ContextEfficiencyReportErrorCode,
  compareContextEfficiencyReports,
  createContextEfficiencyReport,
  isIssuedContextEfficiencyComparison,
  isIssuedContextEfficiencyReport,
  renderContextEfficiencyTerminal,
  serializeContextEfficiencyJson,
  writeContextEfficiencyJson,
} from "./context-efficiency-report.js";
export type {
  CompareContextEfficiencyReportsInput,
  ContextEfficiencyComparison,
  ContextEfficiencyReport,
  ContextEfficiencyReportErrorCode as ContextEfficiencyReportErrorCodeType,
  CreateContextEfficiencyReportInput,
  EfficiencyComparisonProfile,
  EfficiencyComparisonValue,
  EfficiencyReportProfile,
  EfficiencyReportScope,
  EfficiencyReportSink,
  EfficiencyReportTerminalOptions,
  EfficiencyReportTokenStatistics,
  EfficiencyReportWriteOptions,
} from "./context-efficiency-report.js";
export type {
  ContextEfficiencyRecommendations,
  ContextEfficiencyRecommendationsErrorCode as ContextEfficiencyRecommendationsErrorCodeType,
  CounterfactualContextMeasurement,
  CounterfactualRetentionProof,
  EfficiencyRecommendationCaveatCode,
  EfficiencyRecommendationEvaluation,
  EfficiencyRecommendationEvidence,
  EfficiencyRecommendationKind,
  EfficiencyRecommendationProfileIdentity,
  EfficiencyRecommendationReasonCode,
  EfficiencyRecommendationScenario,
  EfficiencyRecommendationTargetProjection,
  EfficiencyRecommendationTargetScenario,
  ProjectContextEfficiencyRecommendationsInput,
  ProjectContextEfficiencyRecommendationsOptions,
} from "./context-efficiency-recommendations.js";
