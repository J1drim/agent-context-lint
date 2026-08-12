import type { RepositoryRelativePath } from "./repository-path.js";

export const CONFIGURATION_CONTRACT_VERSION = 1 as const;
export const CONFIGURATION_FILE_NAME = ".agent-context-lint.yml" as const;
export const CONFIGURATION_RULE_SEVERITIES: readonly ["error", "warning", "info", "off"] =
  Object.freeze(["error", "warning", "info", "off"] as const);
export const CONFIGURATION_PROFILE_IDS: readonly [
  "claude-code",
  "codex-cli",
  "copilot-cli",
  "copilot-cloud-agent",
  "copilot-code-review",
  "copilot-vscode",
  "cursor-agent",
  "gemini-cli",
] = Object.freeze([
  "claude-code",
  "codex-cli",
  "copilot-cli",
  "copilot-cloud-agent",
  "copilot-code-review",
  "copilot-vscode",
  "cursor-agent",
  "gemini-cli",
] as const);
export const CONFIGURATION_PROFILE_KEYS: readonly [
  "claudeCode",
  "codexCli",
  "copilotCli",
  "copilotCloudAgent",
  "copilotCodeReview",
  "copilotVscode",
  "cursorAgent",
  "geminiCli",
] = Object.freeze([
  "claudeCode",
  "codexCli",
  "copilotCli",
  "copilotCloudAgent",
  "copilotCodeReview",
  "copilotVscode",
  "cursorAgent",
  "geminiCli",
] as const);
export const CONFIGURATION_SURFACE_IDS: readonly [
  "claude-code/local-session",
  "codex-cli/local-cli-single-cwd",
  "copilot-cli/local-terminal",
  "copilot-cloud-agent/github-hosted",
  "copilot-code-review/github-hosted",
  "copilot-vscode/local-chat",
  "cursor-agent/cli",
  "cursor-agent/ide",
  "gemini-cli/local-terminal",
] = Object.freeze([
  "claude-code/local-session",
  "codex-cli/local-cli-single-cwd",
  "copilot-cli/local-terminal",
  "copilot-cloud-agent/github-hosted",
  "copilot-code-review/github-hosted",
  "copilot-vscode/local-chat",
  "cursor-agent/cli",
  "cursor-agent/ide",
  "gemini-cli/local-terminal",
] as const);
export const PACKAGE_MANAGERS: readonly ["auto", "npm", "pnpm", "yarn", "bun"] = Object.freeze([
  "auto",
  "npm",
  "pnpm",
  "yarn",
  "bun",
] as const);
export const STANDARDS_CHANNELS: readonly ["stable", "preview"] = Object.freeze([
  "stable",
  "preview",
] as const);
export const EFFICIENCY_TOKENIZERS: readonly ["estimate"] = Object.freeze(["estimate"] as const);
export const EFFICIENCY_SCORE_VERSIONS: readonly ["1.0.0"] = Object.freeze(["1.0.0"] as const);
export const EFFICIENCY_COMPONENT_KEYS: readonly [
  "budgetFit",
  "scopePrecision",
  "nonRedundancy",
  "reachability",
  "instructionDensity",
  "crossAgentConsistency",
] = Object.freeze([
  "budgetFit",
  "scopePrecision",
  "nonRedundancy",
  "reachability",
  "instructionDensity",
  "crossAgentConsistency",
] as const);

export interface ConfigurationSourceLimits {
  readonly maximumAliases: number;
  readonly maximumBytes: number;
  readonly maximumCollectionEntries: number;
  readonly maximumDepth: number;
  readonly maximumIssues: number;
  readonly maximumNodes: number;
  readonly maximumScalarBytes: number;
}

export const CONFIGURATION_SOURCE_LIMITS: ConfigurationSourceLimits = Object.freeze({
  maximumAliases: 0,
  maximumBytes: 65_536,
  maximumCollectionEntries: 2_048,
  maximumDepth: 32,
  maximumIssues: 256,
  maximumNodes: 4_096,
  maximumScalarBytes: 16_384,
});

export interface ConfigurationValueLimits {
  readonly maximumContainerEntries: number;
  readonly maximumKeyBytes: number;
  readonly maximumStringBytes: number;
  readonly maximumTotalStringBytes: number;
  readonly maximumValues: number;
}

export const CONFIGURATION_VALUE_LIMITS: ConfigurationValueLimits = Object.freeze({
  maximumContainerEntries: 2_048,
  maximumKeyBytes: 256,
  maximumStringBytes: 16_384,
  maximumTotalStringBytes: 65_536,
  maximumValues: 4_096,
});

export interface ConfigurationUnknownKeyPolicy {
  readonly policy: "reject";
  readonly ruleIdNamespace: string;
  readonly ruleOptionKeys: readonly ["maxTokens", "severity"];
}

export const CONFIGURATION_UNKNOWN_KEY_POLICY: ConfigurationUnknownKeyPolicy = Object.freeze({
  policy: "reject" as const,
  ruleIdNamespace: "rules accepts only keys matching ^ACL[0-9]{3}$" as const,
  ruleOptionKeys: Object.freeze(["maxTokens", "severity"] as const),
});

export type ConfigurationRuleSeverity = (typeof CONFIGURATION_RULE_SEVERITIES)[number];
export type ConfigurationProfileId = (typeof CONFIGURATION_PROFILE_IDS)[number];
export type ConfigurationProfileKey = (typeof CONFIGURATION_PROFILE_KEYS)[number];
export type ConfigurationSurfaceId = (typeof CONFIGURATION_SURFACE_IDS)[number];
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
export type StandardsChannel = (typeof STANDARDS_CHANNELS)[number];
export type EfficiencyTokenizer = (typeof EFFICIENCY_TOKENIZERS)[number];
export type EfficiencyScoreVersion = (typeof EFFICIENCY_SCORE_VERSIONS)[number];
export type EfficiencyComponentKey = (typeof EFFICIENCY_COMPONENT_KEYS)[number];

export interface ProfileConfiguration {
  readonly enabled: boolean;
  readonly surfaces: Readonly<Partial<Record<ConfigurationSurfaceId, boolean>>>;
}

export interface RuleConfiguration {
  readonly severity: ConfigurationRuleSeverity;
  readonly maxTokens: number | null;
}

export interface ResourceLimitConfiguration {
  readonly maxDiagnostics: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxImportDepth: number;
  readonly maxImportFanOut: number;
  readonly maxTotalBytes: number;
  readonly maxTraversalDepth: number;
}

export interface AgentContextConfiguration {
  readonly version: typeof CONFIGURATION_CONTRACT_VERSION;
  readonly profiles: Readonly<Record<ConfigurationProfileId, ProfileConfiguration>>;
  readonly rules: Readonly<Record<string, RuleConfiguration>>;
  readonly ignore: readonly string[];
  readonly limits: ResourceLimitConfiguration;
  readonly commands: { readonly packageManager: PackageManager };
  readonly security: {
    readonly allowAbsolutePaths: boolean;
    readonly allowNetworkReferences: boolean;
  };
  readonly standards: {
    readonly channel: StandardsChannel;
    readonly lockfile: RepositoryRelativePath;
    readonly maxAgeDays: number;
    readonly requireCurrentInCI: boolean;
  };
  readonly efficiency: {
    readonly tokenizer: EfficiencyTokenizer;
    readonly scoreVersion: EfficiencyScoreVersion;
    readonly budgets: {
      readonly alwaysOnTokens: number;
      readonly effectiveP95Tokens: number;
    };
    readonly gradeThresholds: {
      readonly A: number;
      readonly B: number;
      readonly C: number;
      readonly D: number;
    };
    readonly componentWeights: Readonly<Record<EfficiencyComponentKey, number>>;
  };
}

export interface ConfigurationSourcePosition {
  readonly byteOffset: number;
  readonly utf16Offset: number;
  readonly line: number;
  readonly utf16Column: number;
}

export interface ConfigurationSourceRange {
  readonly start: ConfigurationSourcePosition;
  readonly end: ConfigurationSourcePosition;
}

export interface ConfigurationSourceLocation {
  readonly path: RepositoryRelativePath;
  readonly range: ConfigurationSourceRange;
}

export type ConfigurationValidationCode =
  | "alias-forbidden"
  | "duplicate-key"
  | "invalid-value"
  | "invalid-yaml"
  | "missing-field"
  | "resource-limit"
  | "unknown-field";

export interface ConfigurationValidationIssue {
  readonly code: ConfigurationValidationCode;
  readonly path: string;
  readonly message: string;
  readonly location: ConfigurationSourceLocation | null;
}

export type ConfigurationValidationResult =
  | { readonly ok: true; readonly value: AgentContextConfiguration; readonly issues: readonly [] }
  | {
      readonly ok: false;
      readonly value?: never;
      readonly issues: readonly ConfigurationValidationIssue[];
    };

const SAFE_CONFIGURATION_PATH_PROPERTY = /^[A-Za-z][A-Za-z0-9]*$/u;
const RESERVED_CONFIGURATION_PATH_PROPERTIES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Append one unambiguous property segment to a configuration diagnostic path. */
export function appendConfigurationPathProperty(path: string, property: string): string {
  return SAFE_CONFIGURATION_PATH_PROPERTY.test(property) &&
    !RESERVED_CONFIGURATION_PATH_PROPERTIES.has(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

const SURFACES_BY_PROFILE: Readonly<
  Record<ConfigurationProfileId, readonly ConfigurationSurfaceId[]>
> = Object.freeze({
  "claude-code": Object.freeze(["claude-code/local-session"] as const),
  "codex-cli": Object.freeze(["codex-cli/local-cli-single-cwd"] as const),
  "copilot-cli": Object.freeze(["copilot-cli/local-terminal"] as const),
  "copilot-cloud-agent": Object.freeze(["copilot-cloud-agent/github-hosted"] as const),
  "copilot-code-review": Object.freeze(["copilot-code-review/github-hosted"] as const),
  "copilot-vscode": Object.freeze(["copilot-vscode/local-chat"] as const),
  "cursor-agent": Object.freeze(["cursor-agent/cli", "cursor-agent/ide"] as const),
  "gemini-cli": Object.freeze(["gemini-cli/local-terminal"] as const),
});

export const CONFIGURATION_PROFILE_KEY_BY_ID: Readonly<
  Record<ConfigurationProfileId, ConfigurationProfileKey>
> = Object.freeze({
  "claude-code": "claudeCode",
  "codex-cli": "codexCli",
  "copilot-cli": "copilotCli",
  "copilot-cloud-agent": "copilotCloudAgent",
  "copilot-code-review": "copilotCodeReview",
  "copilot-vscode": "copilotVscode",
  "cursor-agent": "cursorAgent",
  "gemini-cli": "geminiCli",
});

export const CONFIGURATION_SURFACES_BY_PROFILE: Readonly<
  Record<ConfigurationProfileId, readonly ConfigurationSurfaceId[]>
> = SURFACES_BY_PROFILE;

function createDefaultProfiles(): Record<ConfigurationProfileId, ProfileConfiguration> {
  return Object.fromEntries(
    CONFIGURATION_PROFILE_IDS.map((profileId) => [
      profileId,
      {
        enabled: true,
        surfaces: Object.fromEntries(
          SURFACES_BY_PROFILE[profileId].map((surfaceId) => [surfaceId, true]),
        ),
      },
    ]),
  ) as Record<ConfigurationProfileId, ProfileConfiguration>;
}

/** Built-in B06 defaults. B07 may overlay repository and CLI values without mutating this value. */
export const DEFAULT_AGENT_CONTEXT_CONFIGURATION: AgentContextConfiguration = Object.freeze({
  commands: Object.freeze({ packageManager: "auto" }),
  efficiency: Object.freeze({
    budgets: Object.freeze({ alwaysOnTokens: 2_500, effectiveP95Tokens: 5_000 }),
    componentWeights: Object.freeze({
      budgetFit: 30,
      scopePrecision: 25,
      nonRedundancy: 20,
      reachability: 10,
      instructionDensity: 10,
      crossAgentConsistency: 5,
    }),
    gradeThresholds: Object.freeze({ A: 90, B: 80, C: 70, D: 55 }),
    scoreVersion: "1.0.0",
    tokenizer: "estimate",
  }),
  ignore: Object.freeze([]),
  limits: Object.freeze({
    maxDiagnostics: 10_000,
    maxFileBytes: 1_048_576,
    maxFiles: 100_000,
    maxImportDepth: 16,
    maxImportFanOut: 128,
    maxTotalBytes: 67_108_864,
    maxTraversalDepth: 128,
  }),
  profiles: Object.freeze(
    Object.fromEntries(
      Object.entries(createDefaultProfiles()).map(([profileId, profile]) => [
        profileId,
        Object.freeze({ ...profile, surfaces: Object.freeze(profile.surfaces) }),
      ]),
    ) as Record<ConfigurationProfileId, ProfileConfiguration>,
  ),
  rules: Object.freeze({}),
  security: Object.freeze({ allowAbsolutePaths: false, allowNetworkReferences: false }),
  standards: Object.freeze({
    channel: "stable",
    lockfile: "agent-context-standards.lock.json" as RepositoryRelativePath,
    maxAgeDays: 30,
    requireCurrentInCI: false,
  }),
  version: CONFIGURATION_CONTRACT_VERSION,
});
