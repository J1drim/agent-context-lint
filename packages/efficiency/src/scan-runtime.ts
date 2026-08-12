import { countEstimatedTokens } from "./estimate-tokenizer.js";
import { projectContextEfficiencyRecommendationsWithTokenCounter } from "./context-efficiency-recommendations.js";
import type {
  ContextEfficiencyRecommendations,
  ProjectContextEfficiencyRecommendationsOptions,
  RecommendationTokenCounter,
} from "./context-efficiency-recommendations.js";
import { BUILTIN_ESTIMATE_PROVIDER_ID } from "./tokenizer-contract.js";

export { countEstimatedTokens } from "./estimate-tokenizer.js";

export {
  BUILTIN_ESTIMATE_IDENTITY,
  BUILTIN_ESTIMATE_PROVIDER_ID,
  compareTokenizerIdentities,
} from "./tokenizer-contract.js";
export type { TokenCount } from "./tokenizer-contract.js";

export {
  accountOccurrenceTokens,
  combineOccurrenceTokenAccountings,
} from "./occurrence-token-accounting.js";

export {
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  analyzeContextEfficiencyMetrics,
  isIssuedContextEfficiencyMetrics,
} from "./context-efficiency-metrics.js";
export type {
  ContextEfficiencyMetrics,
  EfficiencyMetricProfileInput,
  ProfileMetricIdentity,
} from "./context-efficiency-metrics.js";

export {
  calculateContextEfficiencyScore,
  isIssuedContextEfficiencyScore,
} from "./context-efficiency-score.js";
export type { ContextEfficiencyScore } from "./context-efficiency-score.js";

export { createContextEfficiencyReport } from "./context-efficiency-report.js";
export type { ContextEfficiencyReport } from "./context-efficiency-report.js";

export {
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  isIssuedContextEfficiencyRecommendations,
} from "./context-efficiency-recommendations.js";
export type {
  ContextEfficiencyRecommendations,
  EfficiencyRecommendationEvaluation,
  EfficiencyRecommendationScenario,
} from "./context-efficiency-recommendations.js";

const countEstimateOnly: RecommendationTokenCounter = (providerId, text) => {
  if (providerId !== BUILTIN_ESTIMATE_PROVIDER_ID) return Promise.resolve(null);
  const result = countEstimatedTokens(text);
  return Promise.resolve(result.ok ? result.value : null);
};

/** Scan-only G08 entrypoint with no optional provider discovery or worker capability. */
export function projectContextEfficiencyRecommendations(
  input: unknown,
  options?: ProjectContextEfficiencyRecommendationsOptions,
): Promise<ContextEfficiencyRecommendations> {
  return projectContextEfficiencyRecommendationsWithTokenCounter(input, countEstimateOnly, options);
}
