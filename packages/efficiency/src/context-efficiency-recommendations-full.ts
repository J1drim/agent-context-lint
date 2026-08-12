import { countTokensWithProvider } from "./exact-tokenizer.js";
import { projectContextEfficiencyRecommendationsWithTokenCounter } from "./context-efficiency-recommendations.js";
import type {
  ContextEfficiencyRecommendations,
  ProjectContextEfficiencyRecommendationsOptions,
  RecommendationTokenCounter,
} from "./context-efficiency-recommendations.js";

const countWithSelectedProvider: RecommendationTokenCounter = async (providerId, text, signal) => {
  const result = await countTokensWithProvider(providerId, text, {
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok && result.value.fallback === undefined ? result.value.count : null;
};

/** Full G08 entrypoint, including the isolated optional exact-tokenizer provider. */
export function projectContextEfficiencyRecommendations(
  input: unknown,
  options?: ProjectContextEfficiencyRecommendationsOptions,
): Promise<ContextEfficiencyRecommendations> {
  return projectContextEfficiencyRecommendationsWithTokenCounter(
    input,
    countWithSelectedProvider,
    options,
  );
}
