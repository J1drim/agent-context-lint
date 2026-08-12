import {
  MAX_VALIDATION_ISSUES,
  ValidationIssueLimitReached,
  validateJsonValue,
} from "./contract-validation.js";
import {
  CONFIGURATION_CONTRACT_VERSION,
  CONFIGURATION_PROFILE_IDS,
  CONFIGURATION_PROFILE_KEYS,
  CONFIGURATION_PROFILE_KEY_BY_ID,
  CONFIGURATION_RULE_SEVERITIES,
  CONFIGURATION_SURFACES_BY_PROFILE,
  CONFIGURATION_VALUE_LIMITS,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  EFFICIENCY_COMPONENT_KEYS,
  EFFICIENCY_SCORE_VERSIONS,
  EFFICIENCY_TOKENIZERS,
  PACKAGE_MANAGERS,
  STANDARDS_CHANNELS,
  appendConfigurationPathProperty,
} from "./configuration-contracts.js";
import { isRepositoryRelativePath } from "./repository-path.js";

import type { JsonValidationLimits } from "./contract-validation.js";
import type {
  AgentContextConfiguration,
  ConfigurationProfileId,
  ConfigurationRuleSeverity,
  ConfigurationSourceLocation,
  ConfigurationValidationCode,
  ConfigurationValidationIssue,
  ConfigurationValidationResult,
  ProfileConfiguration,
  RuleConfiguration,
} from "./configuration-contracts.js";

type UnknownRecord = Record<string, unknown>;
type LocationLookup = (path: string) => ConfigurationSourceLocation | null;

const SEVERITY_SET: ReadonlySet<string> = new Set(CONFIGURATION_RULE_SEVERITIES);
const PACKAGE_MANAGER_SET: ReadonlySet<string> = new Set(PACKAGE_MANAGERS);
const STANDARDS_CHANNEL_SET: ReadonlySet<string> = new Set(STANDARDS_CHANNELS);
const TOKENIZER_SET: ReadonlySet<string> = new Set(EFFICIENCY_TOKENIZERS);
const SCORE_VERSION_SET: ReadonlySet<string> = new Set(EFFICIENCY_SCORE_VERSIONS);
const RULE_ID_PATTERN = /^ACL[0-9]{3}$/;

const VALUE_LIMITS: JsonValidationLimits = CONFIGURATION_VALUE_LIMITS;

interface ValidationContext {
  readonly issues: ConfigurationValidationIssue[];
  readonly locate: LocationLookup;
  readonly locateKey: LocationLookup;
}

function addIssue(
  context: ValidationContext,
  code: ConfigurationValidationCode,
  path: string,
  message: string,
  location: ConfigurationSourceLocation | null = context.locate(path),
): void {
  if (context.issues.length >= MAX_VALIDATION_ISSUES - 1) {
    if (context.issues.length === MAX_VALIDATION_ISSUES - 1) {
      context.issues.push({
        code: "resource-limit",
        location: context.locate("$"),
        message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
        path: "$",
      });
    }
    throw new ValidationIssueLimitReached();
  }
  context.issues.push({ code, location, message, path });
}

function objectValue(
  value: unknown,
  path: string,
  keys: readonly string[],
  context: ValidationContext,
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      const keyPath = appendConfigurationPathProperty(path, key);
      addIssue(
        context,
        "unknown-field",
        keyPath,
        "is not part of configuration version 1",
        context.locateKey(keyPath),
      );
    }
  }
  return record;
}

function optionalBoolean(
  record: UnknownRecord,
  key: string,
  path: string,
  fallback: boolean,
  context: ValidationContext,
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    addIssue(context, "invalid-value", `${path}.${key}`, "must be a boolean");
    return fallback;
  }
  return value;
}

function optionalInteger(
  record: UnknownRecord,
  key: string,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
  context: ValidationContext,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    addIssue(
      context,
      "invalid-value",
      `${path}.${key}`,
      `must be a safe integer from ${String(minimum)} through ${String(maximum)}`,
    );
    return fallback;
  }
  return value as number;
}

function optionalEnum<T extends string>(
  record: UnknownRecord,
  key: string,
  path: string,
  fallback: T,
  values: ReadonlySet<string>,
  context: ValidationContext,
): T {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.has(value)) {
    addIssue(context, "invalid-value", `${path}.${key}`, "has an unsupported value");
    return fallback;
  }
  return value as T;
}

function validateProfiles(
  value: unknown,
  context: ValidationContext,
): AgentContextConfiguration["profiles"] {
  const defaults = DEFAULT_AGENT_CONTEXT_CONFIGURATION.profiles;
  if (value === undefined) return defaults;
  const profiles = objectValue(value, "$.profiles", CONFIGURATION_PROFILE_KEYS, context);
  if (profiles === undefined) return defaults;
  const result: Partial<Record<ConfigurationProfileId, ProfileConfiguration>> = {};
  for (const profileId of CONFIGURATION_PROFILE_IDS) {
    const profileKey = CONFIGURATION_PROFILE_KEY_BY_ID[profileId];
    const profilePath = `$.profiles.${profileKey}`;
    const defaultProfile = defaults[profileId];
    const candidate = profiles[profileKey];
    if (candidate === undefined) {
      result[profileId] = defaultProfile;
      continue;
    }
    if (typeof candidate === "boolean") {
      result[profileId] = { enabled: candidate, surfaces: { ...defaultProfile.surfaces } };
      continue;
    }
    const profile = objectValue(candidate, profilePath, ["enabled", "surfaces"], context);
    if (profile === undefined) {
      result[profileId] = defaultProfile;
      continue;
    }
    const surfacesValue = profile["surfaces"];
    let surfaces = { ...defaultProfile.surfaces };
    if (surfacesValue !== undefined) {
      const allowedSurfaces = CONFIGURATION_SURFACES_BY_PROFILE[profileId];
      const surfaceRecord = objectValue(
        surfacesValue,
        `${profilePath}.surfaces`,
        allowedSurfaces,
        context,
      );
      if (surfaceRecord !== undefined) {
        surfaces = Object.fromEntries(
          allowedSurfaces.map((surfaceId) => {
            const enabled = surfaceRecord[surfaceId];
            if (enabled !== undefined && typeof enabled !== "boolean") {
              addIssue(
                context,
                "invalid-value",
                appendConfigurationPathProperty(`${profilePath}.surfaces`, surfaceId),
                "must be a boolean",
              );
            }
            return [surfaceId, typeof enabled === "boolean" ? enabled : true];
          }),
        );
      }
    }
    result[profileId] = {
      enabled: optionalBoolean(profile, "enabled", profilePath, true, context),
      surfaces,
    };
  }
  return result as AgentContextConfiguration["profiles"];
}

function validateRules(
  value: unknown,
  context: ValidationContext,
): Readonly<Record<string, RuleConfiguration>> {
  if (value === undefined) return DEFAULT_AGENT_CONTEXT_CONFIGURATION.rules;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid-value", "$.rules", "must be an object keyed by rule ID");
    return DEFAULT_AGENT_CONTEXT_CONFIGURATION.rules;
  }
  const rules = value as UnknownRecord;
  if (Object.keys(rules).length > 512) {
    addIssue(context, "resource-limit", "$.rules", "must not contain more than 512 rule settings");
    return DEFAULT_AGENT_CONTEXT_CONFIGURATION.rules;
  }
  const result: Record<string, RuleConfiguration> = {};
  for (const ruleId of Object.keys(rules).sort()) {
    const rulePath = appendConfigurationPathProperty("$.rules", ruleId);
    if (!RULE_ID_PATTERN.test(ruleId)) {
      addIssue(
        context,
        "unknown-field",
        rulePath,
        "must match ^ACL[0-9]{3}$",
        context.locateKey(rulePath),
      );
      continue;
    }
    const candidate = rules[ruleId];
    if (typeof candidate === "string") {
      if (!SEVERITY_SET.has(candidate)) {
        addIssue(context, "invalid-value", rulePath, "has an unsupported severity");
        continue;
      }
      result[ruleId] = { maxTokens: null, severity: candidate as ConfigurationRuleSeverity };
      continue;
    }
    const rule = objectValue(candidate, rulePath, ["maxTokens", "severity"], context);
    if (rule === undefined) continue;
    if (rule["severity"] === undefined) {
      addIssue(context, "missing-field", `${rulePath}.severity`, "is required");
      continue;
    }
    const severity = optionalEnum(rule, "severity", rulePath, "warning", SEVERITY_SET, context);
    const maxTokens =
      rule["maxTokens"] === undefined || rule["maxTokens"] === null
        ? null
        : optionalInteger(rule, "maxTokens", rulePath, 1, 1, 10_000_000, context);
    result[ruleId] = { maxTokens, severity };
  }
  return result;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function validateIgnore(value: unknown, context: ValidationContext): readonly string[] {
  if (value === undefined) return DEFAULT_AGENT_CONTEXT_CONFIGURATION.ignore;
  if (!Array.isArray(value)) {
    addIssue(context, "invalid-value", "$.ignore", "must be an array of repository glob strings");
    return DEFAULT_AGENT_CONTEXT_CONFIGURATION.ignore;
  }
  if (value.length > 256) {
    addIssue(context, "resource-limit", "$.ignore", "must not contain more than 256 patterns");
    return DEFAULT_AGENT_CONTEXT_CONFIGURATION.ignore;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, pattern] of value.entries()) {
    const itemPath = `$.ignore[${String(index)}]`;
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      hasControlCharacter(pattern) ||
      pattern.includes("\\") ||
      pattern.startsWith("/") ||
      pattern.includes("//") ||
      pattern.split("/").some((segment) => segment === "." || segment === "..") ||
      Array.from(pattern).length > 1_024
    ) {
      addIssue(
        context,
        "invalid-value",
        itemPath,
        "must be a canonical non-empty root-relative POSIX glob within 1024 Unicode code points",
      );
    } else if (seen.has(pattern)) {
      addIssue(context, "invalid-value", itemPath, "duplicates an earlier ignore pattern");
    } else {
      seen.add(pattern);
      result.push(pattern);
    }
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface ConfigurationValidationOptions {
  readonly locate?: LocationLookup;
  readonly locateKey?: LocationLookup;
}

/** Validate and default an already parsed configuration value without filesystem or process access. */
export function validateAgentContextConfiguration(
  input: unknown,
  options: ConfigurationValidationOptions = {},
): ConfigurationValidationResult {
  const context: ValidationContext = {
    issues: [],
    locate: options.locate ?? ((): null => null),
    locateKey: options.locateKey ?? options.locate ?? ((): null => null),
  };
  try {
    if (
      !validateJsonValue(
        input,
        "$",
        (code, path, message): void => {
          addIssue(
            context,
            code === "resource-limit" ? "resource-limit" : "invalid-value",
            path,
            message,
          );
        },
        VALUE_LIMITS,
      )
    ) {
      return { issues: context.issues, ok: false };
    }
    const root = objectValue(
      input,
      "$",
      [
        "commands",
        "efficiency",
        "ignore",
        "limits",
        "profiles",
        "rules",
        "security",
        "standards",
        "version",
      ],
      context,
    );
    if (root === undefined) return { issues: context.issues, ok: false };
    if (root["version"] === undefined) {
      addIssue(context, "missing-field", "$.version", "is required");
    } else if (root["version"] !== CONFIGURATION_CONTRACT_VERSION) {
      addIssue(context, "invalid-value", "$.version", "must equal 1");
    }

    const defaultLimits = DEFAULT_AGENT_CONTEXT_CONFIGURATION.limits;
    const limits =
      root["limits"] === undefined
        ? undefined
        : objectValue(
            root["limits"],
            "$.limits",
            [
              "maxDiagnostics",
              "maxFileBytes",
              "maxFiles",
              "maxImportDepth",
              "maxImportFanOut",
              "maxTotalBytes",
              "maxTraversalDepth",
            ],
            context,
          );
    const normalizedLimits =
      limits === undefined
        ? defaultLimits
        : {
            maxDiagnostics: optionalInteger(
              limits,
              "maxDiagnostics",
              "$.limits",
              defaultLimits.maxDiagnostics,
              1,
              100_000,
              context,
            ),
            maxFileBytes: optionalInteger(
              limits,
              "maxFileBytes",
              "$.limits",
              defaultLimits.maxFileBytes,
              1_024,
              16_777_216,
              context,
            ),
            maxFiles: optionalInteger(
              limits,
              "maxFiles",
              "$.limits",
              defaultLimits.maxFiles,
              1,
              1_000_000,
              context,
            ),
            maxImportDepth: optionalInteger(
              limits,
              "maxImportDepth",
              "$.limits",
              defaultLimits.maxImportDepth,
              1,
              64,
              context,
            ),
            maxImportFanOut: optionalInteger(
              limits,
              "maxImportFanOut",
              "$.limits",
              defaultLimits.maxImportFanOut,
              1,
              4_096,
              context,
            ),
            maxTotalBytes: optionalInteger(
              limits,
              "maxTotalBytes",
              "$.limits",
              defaultLimits.maxTotalBytes,
              1_024,
              1_073_741_824,
              context,
            ),
            maxTraversalDepth: optionalInteger(
              limits,
              "maxTraversalDepth",
              "$.limits",
              defaultLimits.maxTraversalDepth,
              1,
              1_024,
              context,
            ),
          };

    const commands =
      root["commands"] === undefined
        ? undefined
        : objectValue(root["commands"], "$.commands", ["packageManager"], context);
    const security =
      root["security"] === undefined
        ? undefined
        : objectValue(
            root["security"],
            "$.security",
            ["allowAbsolutePaths", "allowNetworkReferences"],
            context,
          );
    const standards =
      root["standards"] === undefined
        ? undefined
        : objectValue(
            root["standards"],
            "$.standards",
            ["channel", "lockfile", "maxAgeDays", "requireCurrentInCI"],
            context,
          );
    const efficiency =
      root["efficiency"] === undefined
        ? undefined
        : objectValue(
            root["efficiency"],
            "$.efficiency",
            ["budgets", "componentWeights", "gradeThresholds", "scoreVersion", "tokenizer"],
            context,
          );
    const budgets =
      efficiency?.["budgets"] === undefined
        ? undefined
        : objectValue(
            efficiency["budgets"],
            "$.efficiency.budgets",
            ["alwaysOnTokens", "effectiveP95Tokens"],
            context,
          );
    const grades =
      efficiency?.["gradeThresholds"] === undefined
        ? undefined
        : objectValue(
            efficiency["gradeThresholds"],
            "$.efficiency.gradeThresholds",
            ["A", "B", "C", "D"],
            context,
          );
    const componentWeights =
      efficiency?.["componentWeights"] === undefined
        ? undefined
        : objectValue(
            efficiency["componentWeights"],
            "$.efficiency.componentWeights",
            EFFICIENCY_COMPONENT_KEYS,
            context,
          );
    const defaultStandards = DEFAULT_AGENT_CONTEXT_CONFIGURATION.standards;
    let lockfile = defaultStandards.lockfile;
    if (standards?.["lockfile"] !== undefined) {
      const candidate = standards["lockfile"];
      if (
        typeof candidate !== "string" ||
        candidate === "." ||
        Array.from(candidate).length > 1_024 ||
        !isRepositoryRelativePath(candidate)
      ) {
        addIssue(
          context,
          "invalid-value",
          "$.standards.lockfile",
          "must be a canonical non-root B01 repository-relative POSIX path",
        );
      } else {
        lockfile = candidate;
      }
    }
    const defaultEfficiency = DEFAULT_AGENT_CONTEXT_CONFIGURATION.efficiency;
    const normalizedGradeThresholds = {
      A: optionalInteger(
        grades ?? {},
        "A",
        "$.efficiency.gradeThresholds",
        defaultEfficiency.gradeThresholds.A,
        0,
        100,
        context,
      ),
      B: optionalInteger(
        grades ?? {},
        "B",
        "$.efficiency.gradeThresholds",
        defaultEfficiency.gradeThresholds.B,
        0,
        100,
        context,
      ),
      C: optionalInteger(
        grades ?? {},
        "C",
        "$.efficiency.gradeThresholds",
        defaultEfficiency.gradeThresholds.C,
        0,
        100,
        context,
      ),
      D: optionalInteger(
        grades ?? {},
        "D",
        "$.efficiency.gradeThresholds",
        defaultEfficiency.gradeThresholds.D,
        0,
        100,
        context,
      ),
    };
    if (!(
      normalizedGradeThresholds.A > normalizedGradeThresholds.B &&
      normalizedGradeThresholds.B > normalizedGradeThresholds.C &&
      normalizedGradeThresholds.C > normalizedGradeThresholds.D
    )) {
      addIssue(
        context,
        "invalid-value",
        "$.efficiency.gradeThresholds",
        "must satisfy A > B > C > D",
      );
    }
    const normalizedComponentWeights = Object.fromEntries(
      EFFICIENCY_COMPONENT_KEYS.map((key) => [
        key,
        optionalInteger(
          componentWeights ?? {},
          key,
          "$.efficiency.componentWeights",
          defaultEfficiency.componentWeights[key],
          0,
          100,
          context,
        ),
      ]),
    ) as AgentContextConfiguration["efficiency"]["componentWeights"];
    if (
      EFFICIENCY_COMPONENT_KEYS.reduce((sum, key) => sum + normalizedComponentWeights[key], 0) !==
      100
    ) {
      addIssue(
        context,
        "invalid-value",
        "$.efficiency.componentWeights",
        "must sum to exactly 100",
      );
    }
    const normalized: AgentContextConfiguration = {
      commands: {
        packageManager: optionalEnum(
          commands ?? {},
          "packageManager",
          "$.commands",
          DEFAULT_AGENT_CONTEXT_CONFIGURATION.commands.packageManager,
          PACKAGE_MANAGER_SET,
          context,
        ),
      },
      efficiency: {
        budgets: {
          alwaysOnTokens: optionalInteger(
            budgets ?? {},
            "alwaysOnTokens",
            "$.efficiency.budgets",
            defaultEfficiency.budgets.alwaysOnTokens,
            0,
            10_000_000,
            context,
          ),
          effectiveP95Tokens: optionalInteger(
            budgets ?? {},
            "effectiveP95Tokens",
            "$.efficiency.budgets",
            defaultEfficiency.budgets.effectiveP95Tokens,
            0,
            10_000_000,
            context,
          ),
        },
        componentWeights: normalizedComponentWeights,
        gradeThresholds: normalizedGradeThresholds,
        scoreVersion: optionalEnum(
          efficiency ?? {},
          "scoreVersion",
          "$.efficiency",
          defaultEfficiency.scoreVersion,
          SCORE_VERSION_SET,
          context,
        ),
        tokenizer: optionalEnum(
          efficiency ?? {},
          "tokenizer",
          "$.efficiency",
          defaultEfficiency.tokenizer,
          TOKENIZER_SET,
          context,
        ),
      },
      ignore: validateIgnore(root["ignore"], context),
      limits: normalizedLimits,
      profiles: validateProfiles(root["profiles"], context),
      rules: validateRules(root["rules"], context),
      security: {
        allowAbsolutePaths: optionalBoolean(
          security ?? {},
          "allowAbsolutePaths",
          "$.security",
          false,
          context,
        ),
        allowNetworkReferences: optionalBoolean(
          security ?? {},
          "allowNetworkReferences",
          "$.security",
          false,
          context,
        ),
      },
      standards: {
        channel: optionalEnum(
          standards ?? {},
          "channel",
          "$.standards",
          defaultStandards.channel,
          STANDARDS_CHANNEL_SET,
          context,
        ),
        lockfile,
        maxAgeDays: optionalInteger(
          standards ?? {},
          "maxAgeDays",
          "$.standards",
          defaultStandards.maxAgeDays,
          1,
          365,
          context,
        ),
        requireCurrentInCI: optionalBoolean(
          standards ?? {},
          "requireCurrentInCI",
          "$.standards",
          defaultStandards.requireCurrentInCI,
          context,
        ),
      },
      version: CONFIGURATION_CONTRACT_VERSION,
    };
    return context.issues.length === 0
      ? { issues: [], ok: true, value: deepFreeze(normalized) }
      : { issues: context.issues, ok: false };
  } catch (error) {
    if (!(error instanceof ValidationIssueLimitReached)) throw error;
    return { issues: context.issues, ok: false };
  }
}
