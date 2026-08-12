import { types as nodeTypes } from "node:util";

import {
  CONFIGURATION_CONTRACT_VERSION,
  CONFIGURATION_PROFILE_IDS,
  CONFIGURATION_RULE_SEVERITIES,
  CONFIGURATION_SURFACES_BY_PROFILE,
  EFFICIENCY_SCORE_VERSIONS,
  EFFICIENCY_TOKENIZERS,
  PACKAGE_MANAGERS,
  STANDARDS_CHANNELS,
} from "./configuration-contracts.js";
import { PROFILE_CATALOG_CONTRACT_VERSION } from "./profile-contracts.js";
import { isRepositoryRelativePath, REPOSITORY_ROOT } from "./repository-path.js";

import type {
  ConfigurationProfileId,
  ConfigurationRuleSeverity,
  ConfigurationSourceLocation,
  ConfigurationSurfaceId,
} from "./configuration-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const ORGANIZATION_POLICY_PACK_SCHEMA_VERSION = "0.1.0" as const;
export const ORGANIZATION_POLICY_AUTHORITIES = ["default", "enforced"] as const;
export const ORGANIZATION_POLICY_TARGET_KINDS = ["profile", "rule", "setting", "surface"] as const;
export const ORGANIZATION_POLICY_SETTING_IDS = [
  "commands.packageManager",
  "efficiency.budgets.alwaysOnTokens",
  "efficiency.budgets.effectiveP95Tokens",
  "efficiency.componentWeights.budgetFit",
  "efficiency.componentWeights.crossAgentConsistency",
  "efficiency.componentWeights.instructionDensity",
  "efficiency.componentWeights.nonRedundancy",
  "efficiency.componentWeights.reachability",
  "efficiency.componentWeights.scopePrecision",
  "efficiency.gradeThresholds.A",
  "efficiency.gradeThresholds.B",
  "efficiency.gradeThresholds.C",
  "efficiency.gradeThresholds.D",
  "efficiency.scoreVersion",
  "efficiency.tokenizer",
  "standards.channel",
  "standards.maxAgeDays",
  "standards.requireCurrentInCI",
] as const;

export const ORGANIZATION_POLICY_LIMITS: Readonly<{
  maximumContainerEntries: number;
  maximumIssues: number;
  maximumKeyBytes: number;
  maximumPolicies: number;
  maximumStringBytes: number;
  maximumTotalStringBytes: number;
  maximumValues: number;
}> = Object.freeze({
  maximumContainerEntries: 2_048,
  maximumIssues: 256,
  maximumKeyBytes: 256,
  maximumPolicies: 512,
  maximumStringBytes: 4_096,
  maximumTotalStringBytes: 65_536,
  maximumValues: 4_096,
});

Object.freeze(ORGANIZATION_POLICY_AUTHORITIES);
Object.freeze(ORGANIZATION_POLICY_TARGET_KINDS);
Object.freeze(ORGANIZATION_POLICY_SETTING_IDS);

export type OrganizationPolicyAuthority = (typeof ORGANIZATION_POLICY_AUTHORITIES)[number];
export type OrganizationPolicySettingId = (typeof ORGANIZATION_POLICY_SETTING_IDS)[number];
export type OrganizationPolicyTargetKind = (typeof ORGANIZATION_POLICY_TARGET_KINDS)[number];

export interface OrganizationPolicyCapabilities {
  readonly engineVersion: string;
  readonly ruleIds: readonly string[];
  readonly ruleRegistryVersion: string;
}

export interface OrganizationPolicyCompatibility {
  readonly configurationVersion: typeof CONFIGURATION_CONTRACT_VERSION;
  readonly minimumEngineVersion: string;
  readonly profileCatalogVersion: typeof PROFILE_CATALOG_CONTRACT_VERSION;
  readonly ruleRegistryVersion: string;
}

export interface OrganizationPolicyProvenance {
  readonly approvedBy: string;
  readonly approvedSource: {
    readonly path: RepositoryRelativePath;
    readonly sha256: string;
  };
  readonly reviewedAt: string;
  readonly revision: string | null;
}

export type OrganizationPolicyTarget =
  | { readonly kind: "profile"; readonly profileId: ConfigurationProfileId }
  | { readonly kind: "rule"; readonly ruleId: string }
  | { readonly kind: "setting"; readonly settingId: OrganizationPolicySettingId }
  | {
      readonly kind: "surface";
      readonly profileId: ConfigurationProfileId;
      readonly surfaceId: ConfigurationSurfaceId;
    };

export interface OrganizationPolicyRuleValue {
  readonly maxTokens: number | null;
  readonly severity: ConfigurationRuleSeverity;
}

export type OrganizationPolicyValue = boolean | number | string | OrganizationPolicyRuleValue;

export interface OrganizationPolicyEntry {
  readonly authority: OrganizationPolicyAuthority;
  readonly id: string;
  readonly target: OrganizationPolicyTarget;
  readonly value: OrganizationPolicyValue;
}

export interface OrganizationPolicyPack {
  readonly compatibility: OrganizationPolicyCompatibility;
  readonly packId: string;
  readonly packVersion: string;
  readonly policies: readonly OrganizationPolicyEntry[];
  readonly provenance: OrganizationPolicyProvenance;
  readonly recordKind: "agent-context-organization-policy-pack";
  readonly schemaVersion: typeof ORGANIZATION_POLICY_PACK_SCHEMA_VERSION;
}

export interface OrganizationPolicyPackOrigin {
  /** SHA-256 of the exact local pack bytes, calculated before decoding. */
  readonly sha256: string;
  /** Canonical path selected beneath the repository root. Filesystem containment is a C02 concern. */
  readonly path: RepositoryRelativePath;
}

export interface OrganizationPolicyLocationProvider {
  readonly locate?: (path: string) => ConfigurationSourceLocation | null;
  readonly locateKey?: (parentPath: string, key: string) => ConfigurationSourceLocation | null;
}

export interface ValidateOrganizationPolicyPackOptions extends OrganizationPolicyLocationProvider {
  readonly capabilities: OrganizationPolicyCapabilities;
  readonly origin: OrganizationPolicyPackOrigin;
}

export type OrganizationPolicyIssueCode =
  | "conflict"
  | "duplicate-id"
  | "duplicate-target"
  | "forbidden-field"
  | "invalid-capabilities"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field"
  | "unsupported-target"
  | "unsupported-version";

export interface OrganizationPolicyIssue {
  readonly code: OrganizationPolicyIssueCode;
  readonly location: ConfigurationSourceLocation | null;
  readonly message: string;
  readonly path: string;
  readonly relatedLocation: ConfigurationSourceLocation | null;
}

export interface ValidatedOrganizationPolicyPack {
  readonly document: OrganizationPolicyPack;
  readonly origin: OrganizationPolicyPackOrigin;
  readonly policyLocations: Readonly<Record<string, ConfigurationSourceLocation | null>>;
}

export type OrganizationPolicyValidationResult =
  | {
      readonly issues: readonly [];
      readonly ok: true;
      readonly value: ValidatedOrganizationPolicyPack;
    }
  | {
      readonly issues: readonly OrganizationPolicyIssue[];
      readonly ok: false;
      readonly value?: never;
    };

export type OrganizationPolicyOverrideSource =
  | {
      readonly kind: "cli";
      readonly argument: string;
    }
  | {
      readonly kind: "repository";
      readonly location: ConfigurationSourceLocation;
    };

export interface OrganizationPolicyOverride {
  readonly id: string;
  readonly source: OrganizationPolicyOverrideSource;
  readonly target: OrganizationPolicyTarget;
  readonly value: OrganizationPolicyValue;
}

export interface ResolveOrganizationPolicyOptions {
  readonly capabilities: OrganizationPolicyCapabilities;
  readonly cli?: readonly OrganizationPolicyOverride[];
  readonly pack: ValidatedOrganizationPolicyPack;
  readonly repository?: readonly OrganizationPolicyOverride[];
}

export type OrganizationPolicyAssignmentSource =
  | { readonly kind: "cli"; readonly argument: string }
  | {
      readonly kind: "organization";
      readonly authority: OrganizationPolicyAuthority;
      readonly policyId: string;
      readonly location: ConfigurationSourceLocation | null;
    }
  | { readonly kind: "repository"; readonly location: ConfigurationSourceLocation };

export interface ResolvedOrganizationPolicyAssignment {
  readonly source: OrganizationPolicyAssignmentSource;
  readonly target: OrganizationPolicyTarget;
  readonly targetKey: string;
  readonly value: OrganizationPolicyValue;
}

export interface OrganizationPolicyResolutionEvent {
  readonly action: "confirmed" | "selected" | "overridden";
  readonly previousSource: OrganizationPolicyAssignmentSource | null;
  readonly source: OrganizationPolicyAssignmentSource;
  readonly targetKey: string;
}

export type OrganizationPolicyResolutionResult =
  | {
      readonly assignments: readonly ResolvedOrganizationPolicyAssignment[];
      readonly events: readonly OrganizationPolicyResolutionEvent[];
      readonly issues: readonly [];
      readonly ok: true;
    }
  | {
      readonly assignments?: never;
      readonly events?: never;
      readonly issues: readonly OrganizationPolicyIssue[];
      readonly ok: false;
    };

export type OrganizationPolicyTargetClassificationResult =
  | { readonly key: string; readonly ok: true; readonly target: OrganizationPolicyTarget }
  | { readonly issue: OrganizationPolicyIssue; readonly ok: false };

type UnknownRecord = Record<string, unknown>;

const validatedOrganizationPolicyPacks = new WeakSet<object>();

const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAXIMUM_ISSUE_MESSAGE_BYTES = 1_024;
const MAXIMUM_ISSUE_PATH_BYTES = 4_096;
const MAXIMUM_LOCATION_PATH_BYTES = 1_024;
const RULE_ID = /^ACL[0-9]{3}$/u;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_FIELD_NAMES = new Set([
  "callback",
  "code",
  "command",
  "eval",
  "executable",
  "expression",
  "function",
  "glob",
  "handler",
  "module",
  "network",
  "plugin",
  "regex",
  "require",
  "script",
  "template",
]);
const PROFILE_IDS = new Set<string>(CONFIGURATION_PROFILE_IDS);
const SETTING_IDS = new Set<string>(ORGANIZATION_POLICY_SETTING_IDS);
const SEVERITIES = new Set<string>(CONFIGURATION_RULE_SEVERITIES);
const PACKAGE_MANAGER_SET = new Set<string>(PACKAGE_MANAGERS);
const STANDARDS_CHANNEL_SET = new Set<string>(STANDARDS_CHANNELS);
const SCORE_VERSION_SET = new Set<string>(EFFICIENCY_SCORE_VERSIONS);
const TOKENIZER_SET = new Set<string>(EFFICIENCY_TOKENIZERS);

class BoundedIssueList extends Array<OrganizationPolicyIssue> {
  public override push(...items: OrganizationPolicyIssue[]): number {
    const remaining = ORGANIZATION_POLICY_LIMITS.maximumIssues - this.length;
    if (remaining <= 0) return this.length;
    return super.push(...items.slice(0, remaining));
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object") {
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const key of Reflect.ownKeys(object))
      deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
    Object.freeze(object);
  }
  return value;
}

function hasSafeUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      const codePoint = ((unit - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
      if ((codePoint & 0xffff) >= 0xfffe) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else if (
      unit <= 0x1f ||
      unit === 0x7f ||
      unit === 0xfeff ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069) ||
      unit === 0x200e ||
      unit === 0x200f ||
      (unit >= 0xfdd0 && unit <= 0xfdef) ||
      (unit & 0xffff) >= 0xfffe
    )
      return false;
  }
  return true;
}

function fitsSafeUtf8(value: string, maximumBytes: number): boolean {
  return (
    value.length <= maximumBytes &&
    hasSafeUnicode(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function sourceLocation(
  options: OrganizationPolicyLocationProvider,
  path: string,
): ConfigurationSourceLocation | null {
  try {
    return normalizeLocation(options.locate?.(boundedIssuePath(path))) ?? null;
  } catch {
    return null;
  }
}

function keySourceLocation(
  options: OrganizationPolicyLocationProvider,
  parentPath: string,
  key: string,
): ConfigurationSourceLocation | null {
  try {
    const boundedParentPath = boundedIssuePath(parentPath);
    const boundedKey = fitsSafeUtf8(key, ORGANIZATION_POLICY_LIMITS.maximumKeyBytes)
      ? key
      : "field";
    const located = normalizeLocation(options.locateKey?.(boundedParentPath, boundedKey));
    return located ?? sourceLocation(options, `${boundedParentPath}.${boundedKey}`);
  } catch {
    return sourceLocation(options, boundedIssuePath(parentPath));
  }
}

function issue(
  code: OrganizationPolicyIssueCode,
  path: string,
  message: string,
  options: OrganizationPolicyLocationProvider,
  relatedLocation: ConfigurationSourceLocation | null = null,
): OrganizationPolicyIssue {
  const boundedPath = boundedIssuePath(path);
  const boundedMessage = fitsSafeUtf8(message, MAXIMUM_ISSUE_MESSAGE_BYTES)
    ? message
    : "organization policy input is invalid";
  return {
    code,
    location: sourceLocation(options, boundedPath),
    message: boundedMessage,
    path: boundedPath,
    relatedLocation,
  };
}

function boundedIssuePath(path: string): string {
  return fitsSafeUtf8(path, MAXIMUM_ISSUE_PATH_BYTES) ? path : "$";
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sortIssues(issues: OrganizationPolicyIssue[]): OrganizationPolicyIssue[] {
  return issues.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object") return false;
  if (nodeTypes.isProxy(value)) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotPlainObject(value: unknown): UnknownRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) return undefined;
    const snapshot = Object.create(null) as UnknownRecord;
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined)
        return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function snapshotClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
): UnknownRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > allowedKeys.length ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    )
      return undefined;
    const snapshot = Object.create(null) as UnknownRecord;
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined)
        return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function validateJsonBoundary(
  value: unknown,
  options: OrganizationPolicyLocationProvider,
): OrganizationPolicyIssue[] {
  const issues = new BoundedIssueList();
  const seen = new Set<object>();
  const stack: { readonly path: string; readonly value: unknown }[] = [{ path: "$", value }];
  let values = 0;
  let totalStringBytes = 0;
  while (stack.length > 0 && issues.length < ORGANIZATION_POLICY_LIMITS.maximumIssues) {
    const current = stack.pop();
    if (current === undefined) break;
    values += 1;
    if (values > ORGANIZATION_POLICY_LIMITS.maximumValues) {
      issues.push(
        issue("resource-limit", current.path, "exceeds the maximum JSON value count", options),
      );
      break;
    }
    const candidate = current.value;
    if (typeof candidate === "string") {
      if (!fitsSafeUtf8(candidate, ORGANIZATION_POLICY_LIMITS.maximumStringBytes)) {
        issues.push(
          issue(
            "invalid-value",
            current.path,
            "must be safe well-formed Unicode within the per-string UTF-8 limit",
            options,
          ),
        );
        continue;
      }
      const bytes = Buffer.byteLength(candidate, "utf8");
      totalStringBytes += bytes;
      if (totalStringBytes > ORGANIZATION_POLICY_LIMITS.maximumTotalStringBytes) {
        issues.push(
          issue(
            "resource-limit",
            current.path,
            "exceeds the aggregate UTF-8 string limit",
            options,
          ),
        );
        break;
      }
      continue;
    }
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0))
        issues.push(issue("invalid-value", current.path, "must be an I-JSON number", options));
      continue;
    }
    if (typeof candidate !== "object") {
      issues.push(issue("invalid-value", current.path, "must contain JSON values only", options));
      continue;
    }
    const object = candidate;
    if (seen.has(object)) {
      issues.push(
        issue(
          "invalid-value",
          current.path,
          "must not contain cycles or repeated object identities",
          options,
        ),
      );
      continue;
    }
    seen.add(object);
    if (nodeTypes.isProxy(object)) {
      issues.push(issue("invalid-value", current.path, "must not contain proxies", options));
      continue;
    }
    if (Array.isArray(candidate)) {
      const keys = Reflect.ownKeys(candidate);
      if (keys.some((key) => typeof key === "symbol") || keys.length !== candidate.length + 1) {
        issues.push(
          issue(
            "invalid-value",
            current.path,
            "must be a dense JSON array without extra properties",
            options,
          ),
        );
        continue;
      }
      if (candidate.length > ORGANIZATION_POLICY_LIMITS.maximumContainerEntries) {
        issues.push(
          issue("resource-limit", current.path, "exceeds the maximum container entries", options),
        );
        continue;
      }
      let validArray = true;
      const children: { readonly path: string; readonly value: unknown }[] = [];
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          issues.push(issue("invalid-value", current.path, "must not contain accessors", options));
          validArray = false;
          break;
        }
        children.push({
          path: boundedIssuePath(`${current.path}[${String(index)}]`),
          value: descriptor.value,
        });
      }
      if (validArray) stack.push(...children);
      continue;
    }
    if (!isPlainObject(candidate)) {
      issues.push(issue("invalid-value", current.path, "must be a plain JSON object", options));
      continue;
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key === "symbol"))
      issues.push(issue("invalid-value", current.path, "must not contain symbol keys", options));
    if (keys.length > ORGANIZATION_POLICY_LIMITS.maximumContainerEntries) {
      issues.push(
        issue("resource-limit", current.path, "exceeds the maximum container entries", options),
      );
      continue;
    }
    for (const key of keys) {
      if (typeof key !== "string") continue;
      if (!fitsSafeUtf8(key, ORGANIZATION_POLICY_LIMITS.maximumKeyBytes)) {
        issues.push(
          issue(
            "invalid-value",
            current.path,
            "contains an invalid or oversized object key",
            options,
          ),
        );
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        issues.push(issue("invalid-value", current.path, "must not contain accessors", options));
        continue;
      }
      const childPath = boundedIssuePath(`${current.path}.${key}`);
      if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase()))
        issues.push(
          issue(
            "forbidden-field",
            childPath,
            `field '${key}' would cross the data-only capability boundary`,
            options,
          ),
        );
      stack.push({ path: childPath, value: descriptor.value });
    }
  }
  return sortIssues(issues);
}

function exactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: OrganizationPolicyIssue[],
  options: OrganizationPolicyLocationProvider,
): UnknownRecord | undefined {
  const snapshot = snapshotPlainObject(value);
  if (snapshot === undefined) {
    issues.push(issue("invalid-value", path, "must be an object", options));
    return undefined;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(snapshot))
    if (!allowed.has(key))
      issues.push({
        ...issue(
          "unknown-field",
          `${path}.${key}`,
          `field '${key}' is not part of the closed contract`,
          options,
        ),
        location: keySourceLocation(options, path, key),
      });
  return snapshot;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: OrganizationPolicyIssue[],
  options: OrganizationPolicyLocationProvider,
  maximumBytes = 256,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    issues.push(issue("missing-field", `${path}.${key}`, "is required", options));
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || !fitsSafeUtf8(value, maximumBytes)) {
    issues.push(
      issue(
        "invalid-value",
        `${path}.${key}`,
        `must be non-empty well-formed Unicode within ${String(maximumBytes)} UTF-8 bytes`,
        options,
      ),
    );
    return undefined;
  }
  return value;
}

function validStableId(
  value: string | undefined,
  path: string,
  issues: OrganizationPolicyIssue[],
  options: OrganizationPolicyLocationProvider,
): value is string {
  if (value === undefined) return false;
  if (!STABLE_ID.test(value)) {
    issues.push(issue("invalid-value", path, "must be a stable identifier", options));
    return false;
  }
  return true;
}

function parseSemver(value: string): readonly [string, string, string, string | null] | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [major, minor, patch, prerelease ?? null];
}

function compareNumericText(left: string, right: string): number {
  return left.length === right.length ? compareText(left, right) : left.length - right.length;
}

function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) return undefined;
  const [aMajor, aMinor, aPatch, aPrerelease] = a;
  const [bMajor, bMinor, bPatch, bPrerelease] = b;
  for (const [aPart, bPart] of [
    [aMajor, bMajor],
    [aMinor, bMinor],
    [aPatch, bPatch],
  ] as const) {
    const compared = compareNumericText(aPart, bPart);
    if (compared !== 0) return compared;
  }
  if (aPrerelease === bPrerelease) return 0;
  if (aPrerelease === null) return 1;
  if (bPrerelease === null) return -1;
  const aParts = aPrerelease.split(".");
  const bParts = bPrerelease.split(".");
  for (let index = 0; index < Math.min(aParts.length, bParts.length); index += 1) {
    const aPart = aParts.at(index);
    const bPart = bParts.at(index);
    if (aPart === undefined || bPart === undefined) break;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return compareNumericText(aPart, bPart);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return compareText(aPart, bPart);
  }
  return aParts.length - bParts.length;
}

function isExactDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

function validateCapabilities(
  input: unknown,
  options: OrganizationPolicyLocationProvider,
): {
  readonly issues: OrganizationPolicyIssue[];
  readonly ruleIds: ReadonlySet<string>;
  readonly value: OrganizationPolicyCapabilities | undefined;
} {
  const issues = new BoundedIssueList();
  const boundaryIssues = validateJsonBoundary(input, {});
  if (boundaryIssues.length > 0) {
    issues.push(
      issue(
        "invalid-capabilities",
        "$capabilities",
        "must be a closed accessor-free capabilities object",
        options,
      ),
    );
    return { issues, ruleIds: new Set(), value: undefined };
  }
  const record = exactObject(
    input,
    "$capabilities",
    ["engineVersion", "ruleIds", "ruleRegistryVersion"],
    issues,
    options,
  );
  if (record === undefined) return { issues, ruleIds: new Set(), value: undefined };
  const engineVersion = record["engineVersion"];
  const ruleRegistryVersion = record["ruleRegistryVersion"];
  const engine =
    typeof engineVersion === "string" && fitsSafeUtf8(engineVersion, 128)
      ? parseSemver(engineVersion)
      : undefined;
  const registry =
    typeof ruleRegistryVersion === "string" && fitsSafeUtf8(ruleRegistryVersion, 128)
      ? parseSemver(ruleRegistryVersion)
      : undefined;
  if (engine === undefined)
    issues.push(
      issue(
        "invalid-capabilities",
        "$capabilities.engineVersion",
        "must be an exact SemVer",
        options,
      ),
    );
  if (registry === undefined)
    issues.push(
      issue(
        "invalid-capabilities",
        "$capabilities.ruleRegistryVersion",
        "must be an exact SemVer",
        options,
      ),
    );
  const ruleIds = new Set<string>();
  const inputRuleIds = record["ruleIds"];
  if (!Array.isArray(inputRuleIds) || inputRuleIds.length > 512)
    issues.push(
      issue(
        "invalid-capabilities",
        "$capabilities.ruleIds",
        "must be an array of at most 512 registered rule IDs",
        options,
      ),
    );
  else
    for (const [index, ruleId] of inputRuleIds.entries()) {
      if (typeof ruleId !== "string" || !RULE_ID.test(ruleId))
        issues.push(
          issue(
            "invalid-capabilities",
            `$capabilities.ruleIds[${String(index)}]`,
            "must be an ACL rule ID",
            options,
          ),
        );
      else if (ruleIds.has(ruleId))
        issues.push(
          issue(
            "invalid-capabilities",
            `$capabilities.ruleIds[${String(index)}]`,
            `duplicates '${ruleId}'`,
            options,
          ),
        );
      else ruleIds.add(ruleId);
    }
  const value =
    issues.length === 0 &&
    typeof engineVersion === "string" &&
    typeof ruleRegistryVersion === "string" &&
    Array.isArray(inputRuleIds)
      ? deepFreeze({ engineVersion, ruleIds: [...ruleIds], ruleRegistryVersion })
      : undefined;
  return { issues, ruleIds, value };
}

function validateTarget(
  value: unknown,
  path: string,
  ruleIds: ReadonlySet<string>,
  issues: OrganizationPolicyIssue[],
  options: OrganizationPolicyLocationProvider,
): OrganizationPolicyTarget | undefined {
  const record = exactObject(
    value,
    path,
    ["kind", "profileId", "ruleId", "settingId", "surfaceId"],
    issues,
    options,
  );
  if (record === undefined) return undefined;
  const kind = requiredString(record, "kind", path, issues, options, 32);
  if (kind === "profile") {
    for (const key of ["ruleId", "settingId", "surfaceId"])
      if (record[key] !== undefined)
        issues.push(
          issue("unknown-field", `${path}.${key}`, `is not allowed for profile targets`, options),
        );
    const profileId = requiredString(record, "profileId", path, issues, options);
    if (profileId !== undefined && PROFILE_IDS.has(profileId))
      return { kind, profileId: profileId as ConfigurationProfileId };
    if (profileId !== undefined)
      issues.push(
        issue(
          "unsupported-target",
          `${path}.profileId`,
          `profile '${profileId}' is not registered`,
          options,
        ),
      );
  } else if (kind === "surface") {
    for (const key of ["ruleId", "settingId"])
      if (record[key] !== undefined)
        issues.push(
          issue("unknown-field", `${path}.${key}`, `is not allowed for surface targets`, options),
        );
    const profileId = requiredString(record, "profileId", path, issues, options);
    const surfaceId = requiredString(record, "surfaceId", path, issues, options);
    if (profileId !== undefined && PROFILE_IDS.has(profileId) && surfaceId !== undefined) {
      const surfaces = CONFIGURATION_SURFACES_BY_PROFILE[
        profileId as ConfigurationProfileId
      ] as readonly string[];
      if (surfaces.includes(surfaceId))
        return {
          kind,
          profileId: profileId as ConfigurationProfileId,
          surfaceId: surfaceId as ConfigurationSurfaceId,
        };
      issues.push(
        issue(
          "unsupported-target",
          `${path}.surfaceId`,
          `surface '${surfaceId}' is not registered for '${profileId}'`,
          options,
        ),
      );
    } else if (profileId !== undefined && !PROFILE_IDS.has(profileId))
      issues.push(
        issue(
          "unsupported-target",
          `${path}.profileId`,
          `profile '${profileId}' is not registered`,
          options,
        ),
      );
  } else if (kind === "rule") {
    for (const key of ["profileId", "settingId", "surfaceId"])
      if (record[key] !== undefined)
        issues.push(
          issue("unknown-field", `${path}.${key}`, `is not allowed for rule targets`, options),
        );
    const ruleId = requiredString(record, "ruleId", path, issues, options);
    if (ruleId !== undefined && ruleIds.has(ruleId)) return { kind, ruleId };
    if (ruleId !== undefined)
      issues.push(
        issue(
          "unsupported-target",
          `${path}.ruleId`,
          `rule '${ruleId}' is not in the engine registry`,
          options,
        ),
      );
  } else if (kind === "setting") {
    for (const key of ["profileId", "ruleId", "surfaceId"])
      if (record[key] !== undefined)
        issues.push(
          issue("unknown-field", `${path}.${key}`, `is not allowed for setting targets`, options),
        );
    const settingId = requiredString(record, "settingId", path, issues, options);
    if (settingId !== undefined && SETTING_IDS.has(settingId))
      return { kind, settingId: settingId as OrganizationPolicySettingId };
    if (settingId !== undefined)
      issues.push(
        issue(
          "unsupported-target",
          `${path}.settingId`,
          `setting '${settingId}' is outside the closed organization-policy capability set`,
          options,
        ),
      );
  } else if (kind !== undefined)
    issues.push(
      issue("invalid-value", `${path}.kind`, `unsupported target kind '${kind}'`, options),
    );
  return undefined;
}

function validateValue(
  value: unknown,
  target: OrganizationPolicyTarget,
  path: string,
  issues: OrganizationPolicyIssue[],
  options: OrganizationPolicyLocationProvider,
): OrganizationPolicyValue | undefined {
  if (target.kind === "profile" || target.kind === "surface") {
    if (typeof value === "boolean") return value;
    issues.push(issue("invalid-value", path, "must be a boolean", options));
    return undefined;
  }
  if (target.kind === "rule") {
    const record = exactObject(value, path, ["maxTokens", "severity"], issues, options);
    if (record === undefined) return undefined;
    const severity = requiredString(record, "severity", path, issues, options, 16);
    if (record["maxTokens"] === undefined)
      issues.push(issue("missing-field", `${path}.maxTokens`, "is required", options));
    const maxTokens = record["maxTokens"];
    const validMax =
      maxTokens === null ||
      (Number.isInteger(maxTokens) &&
        (maxTokens as number) >= 1 &&
        (maxTokens as number) <= 10_000_000);
    if (!validMax)
      issues.push(
        issue(
          "invalid-value",
          `${path}.maxTokens`,
          "must be null or an integer from 1 through 10000000",
          options,
        ),
      );
    if (severity !== undefined && !SEVERITIES.has(severity))
      issues.push(
        issue("invalid-value", `${path}.severity`, "must be a registered rule severity", options),
      );
    if (validMax && severity !== undefined && SEVERITIES.has(severity))
      return {
        maxTokens: maxTokens as number | null,
        severity: severity as ConfigurationRuleSeverity,
      };
    return undefined;
  }
  const setting = target.settingId;
  if (
    setting === "commands.packageManager" &&
    typeof value === "string" &&
    PACKAGE_MANAGER_SET.has(value)
  )
    return value;
  if (
    setting === "standards.channel" &&
    typeof value === "string" &&
    STANDARDS_CHANNEL_SET.has(value)
  )
    return value;
  if (setting === "efficiency.tokenizer" && typeof value === "string" && TOKENIZER_SET.has(value))
    return value;
  if (
    setting === "efficiency.scoreVersion" &&
    typeof value === "string" &&
    SCORE_VERSION_SET.has(value)
  )
    return value;
  if (setting === "standards.requireCurrentInCI" && typeof value === "boolean") return value;
  if (
    setting === "standards.maxAgeDays" &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 365
  )
    return value;
  if (
    setting.startsWith("efficiency.budgets.") &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10_000_000
  )
    return value;
  if (
    setting.startsWith("efficiency.componentWeights.") &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  )
    return value;
  if (
    setting.startsWith("efficiency.gradeThresholds.") &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  )
    return value;
  issues.push(issue("invalid-value", path, `is not a valid value for '${setting}'`, options));
  return undefined;
}

function targetKey(target: OrganizationPolicyTarget): string {
  if (target.kind === "profile") return `profile:${target.profileId}`;
  if (target.kind === "rule") return `rule:${target.ruleId}`;
  if (target.kind === "setting") return `setting:${target.settingId}`;
  return `surface:${target.profileId}:${target.surfaceId}`;
}

function firstIssue(issues: OrganizationPolicyIssue[]): OrganizationPolicyIssue {
  return (
    sortIssues(issues).at(0) ?? {
      code: "invalid-value",
      location: null,
      message: "organization policy validation failed",
      path: "$",
      relatedLocation: null,
    }
  );
}

export function classifyOrganizationPolicyTarget(
  input: unknown,
  capabilities: OrganizationPolicyCapabilities,
): OrganizationPolicyTargetClassificationResult {
  const options: OrganizationPolicyLocationProvider = {};
  const capability = validateCapabilities(capabilities, options);
  if (capability.issues.length > 0)
    return deepFreeze({ issue: firstIssue(capability.issues), ok: false as const });
  const issues = new BoundedIssueList();
  issues.push(...validateJsonBoundary(input, options));
  if (issues.length > 0) return deepFreeze({ issue: firstIssue(issues), ok: false as const });
  const target = validateTarget(input, "$target", capability.ruleIds, issues, options);
  if (target === undefined || issues.length > 0)
    return deepFreeze({ issue: firstIssue(issues), ok: false as const });
  return deepFreeze({ key: targetKey(target), ok: true as const, target });
}

function snapshotValidationOptions(input: unknown): {
  readonly capabilities: unknown;
  readonly issues: OrganizationPolicyIssue[];
  readonly locationProvider: OrganizationPolicyLocationProvider;
  readonly origin: UnknownRecord | undefined;
} {
  const issues = new BoundedIssueList();
  const record = snapshotClosedObject(input, ["capabilities", "locate", "locateKey", "origin"]);
  if (record === undefined) {
    issues.push(
      issue("invalid-value", "$options", "must be a closed accessor-free options object", {}),
    );
    return { capabilities: undefined, issues, locationProvider: {}, origin: undefined };
  }
  const locate = record["locate"];
  const locateKey = record["locateKey"];
  if (
    locate !== undefined &&
    (typeof locate !== "function" || (typeof locate === "function" && nodeTypes.isProxy(locate)))
  )
    issues.push(issue("invalid-value", "$options.locate", "must be a function when supplied", {}));
  if (
    locateKey !== undefined &&
    (typeof locateKey !== "function" ||
      (typeof locateKey === "function" && nodeTypes.isProxy(locateKey)))
  )
    issues.push(
      issue("invalid-value", "$options.locateKey", "must be a function when supplied", {}),
    );
  const locationProvider: OrganizationPolicyLocationProvider = {
    ...(typeof locate === "function" && !nodeTypes.isProxy(locate)
      ? { locate: locate as NonNullable<OrganizationPolicyLocationProvider["locate"]> }
      : {}),
    ...(typeof locateKey === "function" && !nodeTypes.isProxy(locateKey)
      ? { locateKey: locateKey as NonNullable<OrganizationPolicyLocationProvider["locateKey"]> }
      : {}),
  };
  const origin = snapshotClosedObject(record["origin"], ["path", "sha256"]);
  if (origin === undefined)
    issues.push(issue("invalid-value", "$origin", "must be a closed accessor-free origin", {}));
  return { capabilities: record["capabilities"], issues, locationProvider, origin };
}

export function validateOrganizationPolicyPack(
  input: unknown,
  untrustedOptions: ValidateOrganizationPolicyPackOptions,
): OrganizationPolicyValidationResult {
  const optionSnapshot = snapshotValidationOptions(untrustedOptions);
  const locationProvider = optionSnapshot.locationProvider;
  const options = locationProvider;
  const issues = new BoundedIssueList();
  issues.push(...optionSnapshot.issues, ...validateJsonBoundary(input, locationProvider));
  const capability = validateCapabilities(optionSnapshot.capabilities, locationProvider);
  issues.push(...capability.issues);
  const originPath = optionSnapshot.origin?.["path"];
  const originSha256 = optionSnapshot.origin?.["sha256"];
  if (
    typeof originPath !== "string" ||
    !fitsSafeUtf8(originPath, MAXIMUM_LOCATION_PATH_BYTES) ||
    !isRepositoryRelativePath(originPath) ||
    originPath === REPOSITORY_ROOT
  )
    issues.push(
      issue(
        "invalid-value",
        "$origin.path",
        "must be a canonical non-root repository-relative path",
        locationProvider,
      ),
    );
  if (
    typeof originSha256 !== "string" ||
    originSha256.length !== 64 ||
    !fitsSafeUtf8(originSha256, 64) ||
    !SHA256.test(originSha256)
  )
    issues.push(
      issue(
        "invalid-value",
        "$origin.sha256",
        "must be a lowercase SHA-256 digest",
        locationProvider,
      ),
    );
  if (issues.length > 0)
    return deepFreeze({
      issues: sortIssues(issues).slice(0, ORGANIZATION_POLICY_LIMITS.maximumIssues),
      ok: false as const,
    });

  const root = exactObject(
    input,
    "$",
    [
      "compatibility",
      "packId",
      "packVersion",
      "policies",
      "provenance",
      "recordKind",
      "schemaVersion",
    ],
    issues,
    options,
  );
  if (root === undefined) return deepFreeze({ issues: sortIssues(issues), ok: false as const });
  const recordKind = requiredString(root, "recordKind", "$", issues, options);
  const schemaVersion = requiredString(root, "schemaVersion", "$", issues, options);
  const packId = requiredString(root, "packId", "$", issues, options);
  const packVersion = requiredString(root, "packVersion", "$", issues, options);
  if (recordKind !== undefined && recordKind !== "agent-context-organization-policy-pack")
    issues.push(
      issue("invalid-value", "$.recordKind", "must identify an organization policy pack", options),
    );
  if (schemaVersion !== undefined && schemaVersion !== ORGANIZATION_POLICY_PACK_SCHEMA_VERSION)
    issues.push(
      issue(
        "unsupported-version",
        "$.schemaVersion",
        `must equal '${ORGANIZATION_POLICY_PACK_SCHEMA_VERSION}'`,
        options,
      ),
    );
  validStableId(packId, "$.packId", issues, options);
  if (packVersion !== undefined && parseSemver(packVersion) === undefined)
    issues.push(issue("invalid-value", "$.packVersion", "must be an exact SemVer", options));

  const compatibilityRecord = exactObject(
    root["compatibility"],
    "$.compatibility",
    [
      "configurationVersion",
      "minimumEngineVersion",
      "profileCatalogVersion",
      "ruleRegistryVersion",
    ],
    issues,
    options,
  );
  let compatibility: OrganizationPolicyCompatibility | undefined;
  if (compatibilityRecord !== undefined) {
    for (const key of [
      "configurationVersion",
      "minimumEngineVersion",
      "profileCatalogVersion",
      "ruleRegistryVersion",
    ])
      if (compatibilityRecord[key] === undefined)
        issues.push(issue("missing-field", `$.compatibility.${key}`, "is required", options));
    const minimumEngineVersion = compatibilityRecord["minimumEngineVersion"];
    const ruleRegistryVersion = compatibilityRecord["ruleRegistryVersion"];
    if (compatibilityRecord["configurationVersion"] !== CONFIGURATION_CONTRACT_VERSION)
      issues.push(
        issue(
          "unsupported-version",
          "$.compatibility.configurationVersion",
          `must equal ${String(CONFIGURATION_CONTRACT_VERSION)}`,
          options,
        ),
      );
    if (compatibilityRecord["profileCatalogVersion"] !== PROFILE_CATALOG_CONTRACT_VERSION)
      issues.push(
        issue(
          "unsupported-version",
          "$.compatibility.profileCatalogVersion",
          `must equal '${PROFILE_CATALOG_CONTRACT_VERSION}'`,
          options,
        ),
      );
    if (typeof minimumEngineVersion !== "string" || parseSemver(minimumEngineVersion) === undefined)
      issues.push(
        issue(
          "invalid-value",
          "$.compatibility.minimumEngineVersion",
          "must be an exact SemVer",
          options,
        ),
      );
    else if ((compareSemver(capability.value?.engineVersion ?? "", minimumEngineVersion) ?? -1) < 0)
      issues.push(
        issue(
          "unsupported-version",
          "$.compatibility.minimumEngineVersion",
          "requires a newer compatible engine",
          options,
        ),
      );
    if (typeof ruleRegistryVersion !== "string" || parseSemver(ruleRegistryVersion) === undefined)
      issues.push(
        issue(
          "invalid-value",
          "$.compatibility.ruleRegistryVersion",
          "must be an exact SemVer",
          options,
        ),
      );
    else if (ruleRegistryVersion !== capability.value?.ruleRegistryVersion)
      issues.push(
        issue(
          "unsupported-version",
          "$.compatibility.ruleRegistryVersion",
          "does not match the engine rule registry",
          options,
        ),
      );
    if (typeof minimumEngineVersion === "string" && typeof ruleRegistryVersion === "string")
      compatibility = {
        configurationVersion: CONFIGURATION_CONTRACT_VERSION,
        minimumEngineVersion,
        profileCatalogVersion: PROFILE_CATALOG_CONTRACT_VERSION,
        ruleRegistryVersion,
      };
  }

  const provenanceRecord = exactObject(
    root["provenance"],
    "$.provenance",
    ["approvedBy", "approvedSource", "reviewedAt", "revision"],
    issues,
    options,
  );
  let provenance: OrganizationPolicyProvenance | undefined;
  if (provenanceRecord !== undefined) {
    const approvedBy = requiredString(
      provenanceRecord,
      "approvedBy",
      "$.provenance",
      issues,
      options,
    );
    const reviewedAt = requiredString(
      provenanceRecord,
      "reviewedAt",
      "$.provenance",
      issues,
      options,
    );
    if (
      validStableId(approvedBy, "$.provenance.approvedBy", issues, options) &&
      reviewedAt !== undefined &&
      !isExactDate(reviewedAt)
    )
      issues.push(
        issue("invalid-value", "$.provenance.reviewedAt", "must be an RFC 3339 full-date", options),
      );
    const revision = provenanceRecord["revision"];
    if (
      revision !== null &&
      (typeof revision !== "string" || revision.length === 0 || !fitsSafeUtf8(revision, 256))
    )
      issues.push(
        issue(
          "invalid-value",
          "$.provenance.revision",
          "must be null or non-empty bounded safe Unicode",
          options,
        ),
      );
    if (revision === undefined)
      issues.push(issue("missing-field", "$.provenance.revision", "is required", options));
    const approvedSource = exactObject(
      provenanceRecord["approvedSource"],
      "$.provenance.approvedSource",
      ["path", "sha256"],
      issues,
      options,
    );
    let source: OrganizationPolicyProvenance["approvedSource"] | undefined;
    if (approvedSource !== undefined) {
      const sourcePath = requiredString(
        approvedSource,
        "path",
        "$.provenance.approvedSource",
        issues,
        options,
        1024,
      );
      const digest = requiredString(
        approvedSource,
        "sha256",
        "$.provenance.approvedSource",
        issues,
        options,
        64,
      );
      if (
        sourcePath !== undefined &&
        (!isRepositoryRelativePath(sourcePath) || sourcePath === REPOSITORY_ROOT)
      )
        issues.push(
          issue(
            "invalid-value",
            "$.provenance.approvedSource.path",
            "must be a canonical non-root repository-relative path",
            options,
          ),
        );
      if (digest !== undefined && !SHA256.test(digest))
        issues.push(
          issue(
            "invalid-value",
            "$.provenance.approvedSource.sha256",
            "must be a lowercase SHA-256 digest",
            options,
          ),
        );
      if (
        sourcePath !== undefined &&
        isRepositoryRelativePath(sourcePath) &&
        sourcePath !== REPOSITORY_ROOT &&
        digest !== undefined &&
        SHA256.test(digest)
      )
        source = { path: sourcePath, sha256: digest };
      if (sourcePath === originPath)
        issues.push(
          issue(
            "invalid-value",
            "$.provenance.approvedSource.path",
            "must identify a separate approval record rather than the pack itself",
            options,
          ),
        );
    }
    if (
      approvedBy !== undefined &&
      reviewedAt !== undefined &&
      isExactDate(reviewedAt) &&
      (revision === null || typeof revision === "string") &&
      source !== undefined
    )
      provenance = { approvedBy, approvedSource: source, reviewedAt, revision };
  }

  const policiesValue = root["policies"];
  const policies: OrganizationPolicyEntry[] = [];
  const policyLocations: Record<string, ConfigurationSourceLocation | null> = Object.create(
    null,
  ) as Record<string, ConfigurationSourceLocation | null>;
  if (!Array.isArray(policiesValue))
    issues.push(issue("invalid-value", "$.policies", "must be an array", options));
  else if (policiesValue.length > ORGANIZATION_POLICY_LIMITS.maximumPolicies)
    issues.push(
      issue(
        "resource-limit",
        "$.policies",
        `must contain at most ${String(ORGANIZATION_POLICY_LIMITS.maximumPolicies)} policies`,
        options,
      ),
    );
  else {
    const ids = new Set<string>();
    const targets = new Set<string>();
    for (const [index, policyValue] of policiesValue.entries()) {
      const path = `$.policies[${String(index)}]`;
      const record = exactObject(
        policyValue,
        path,
        ["authority", "id", "target", "value"],
        issues,
        options,
      );
      if (record === undefined) continue;
      const id = requiredString(record, "id", path, issues, options);
      const authority = requiredString(record, "authority", path, issues, options, 16);
      if (id !== undefined && validStableId(id, `${path}.id`, issues, options)) {
        if (ids.has(id))
          issues.push(issue("duplicate-id", `${path}.id`, `duplicates policy '${id}'`, options));
        ids.add(id);
      }
      if (
        authority !== undefined &&
        !ORGANIZATION_POLICY_AUTHORITIES.includes(authority as OrganizationPolicyAuthority)
      )
        issues.push(
          issue("invalid-value", `${path}.authority`, "must be 'default' or 'enforced'", options),
        );
      const target = validateTarget(
        record["target"],
        `${path}.target`,
        capability.ruleIds,
        issues,
        options,
      );
      const value =
        target === undefined
          ? undefined
          : validateValue(record["value"], target, `${path}.value`, issues, options);
      if (target !== undefined) {
        const key = targetKey(target);
        if (targets.has(key))
          issues.push(
            issue(
              "duplicate-target",
              `${path}.target`,
              `duplicates policy target '${key}'`,
              options,
            ),
          );
        targets.add(key);
      }
      if (
        id !== undefined &&
        authority !== undefined &&
        ORGANIZATION_POLICY_AUTHORITIES.includes(authority as OrganizationPolicyAuthority) &&
        target !== undefined &&
        value !== undefined
      ) {
        policies.push({ authority: authority as OrganizationPolicyAuthority, id, target, value });
        policyLocations[id] = sourceLocation(options, path);
      }
    }
  }

  if (
    issues.length > 0 ||
    compatibility === undefined ||
    provenance === undefined ||
    packId === undefined ||
    packVersion === undefined
  )
    return deepFreeze({
      issues: sortIssues(issues).slice(0, ORGANIZATION_POLICY_LIMITS.maximumIssues),
      ok: false as const,
    });
  policies.sort((left, right) => compareText(left.id, right.id));
  const document: OrganizationPolicyPack = {
    compatibility,
    packId,
    packVersion,
    policies,
    provenance,
    recordKind: "agent-context-organization-policy-pack",
    schemaVersion: ORGANIZATION_POLICY_PACK_SCHEMA_VERSION,
  };
  const origin = { path: originPath as RepositoryRelativePath, sha256: originSha256 as string };
  const result = deepFreeze({
    issues: [] as const,
    ok: true as const,
    value: { document, origin, policyLocations },
  });
  validatedOrganizationPolicyPacks.add(result.value);
  return result;
}

function valuesEqual(left: OrganizationPolicyValue, right: OrganizationPolicyValue): boolean {
  if (typeof left !== "object" || typeof right !== "object") return left === right;
  return left.maxTokens === right.maxTokens && left.severity === right.severity;
}

function sourceOfOverride(
  override: OrganizationPolicyOverride,
): OrganizationPolicyAssignmentSource {
  return override.source.kind === "cli"
    ? { kind: "cli", argument: override.source.argument }
    : { kind: "repository", location: override.source.location };
}

function locationOfSource(
  source: OrganizationPolicyAssignmentSource,
): ConfigurationSourceLocation | null {
  return source.kind === "cli" ? null : source.location;
}

function normalizeLocation(input: unknown): ConfigurationSourceLocation | undefined {
  const inputRecord = snapshotClosedObject(input, ["path", "range"]);
  const inputPath = inputRecord?.["path"];
  if (
    inputRecord === undefined ||
    !Object.hasOwn(inputRecord, "path") ||
    !Object.hasOwn(inputRecord, "range") ||
    typeof inputPath !== "string" ||
    !fitsSafeUtf8(inputPath, MAXIMUM_LOCATION_PATH_BYTES) ||
    !isRepositoryRelativePath(inputPath)
  )
    return undefined;
  const range = snapshotClosedObject(inputRecord["range"], ["end", "start"]);
  if (range === undefined || !Object.hasOwn(range, "start") || !Object.hasOwn(range, "end"))
    return undefined;
  const normalizePosition = (
    value: unknown,
  ): ConfigurationSourceLocation["range"]["start"] | undefined => {
    const record = snapshotClosedObject(value, [
      "byteOffset",
      "line",
      "utf16Column",
      "utf16Offset",
    ]);
    if (
      record === undefined ||
      !["byteOffset", "line", "utf16Column", "utf16Offset"].every((key) =>
        Object.hasOwn(record, key),
      )
    )
      return undefined;
    const byteOffset = record["byteOffset"];
    const line = record["line"];
    const utf16Column = record["utf16Column"];
    const utf16Offset = record["utf16Offset"];
    if (
      typeof byteOffset !== "number" ||
      typeof line !== "number" ||
      typeof utf16Column !== "number" ||
      typeof utf16Offset !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(utf16Column) ||
      !Number.isSafeInteger(utf16Offset) ||
      byteOffset < 0 ||
      line < 1 ||
      utf16Column < 0 ||
      utf16Offset < 0
    )
      return undefined;
    return {
      byteOffset,
      line,
      utf16Column,
      utf16Offset,
    };
  };
  const start = normalizePosition(range["start"]);
  const end = normalizePosition(range["end"]);
  if (
    start === undefined ||
    end === undefined ||
    end.byteOffset < start.byteOffset ||
    end.utf16Offset < start.utf16Offset
  )
    return undefined;
  return { path: inputPath, range: { end, start } };
}

function validateOverrideLayer(
  layer: unknown,
  name: "cli" | "repository",
  ruleIds: ReadonlySet<string>,
): {
  readonly entries: readonly OrganizationPolicyOverride[];
  readonly issues: OrganizationPolicyIssue[];
} {
  const issues = validateJsonBoundary(layer, {});
  if (issues.length > 0) return { entries: [], issues: sortIssues(issues) };
  if (!Array.isArray(layer)) {
    issues.push(issue("invalid-value", `$${name}`, "must be an array", {}));
    return { entries: [], issues: sortIssues(issues) };
  }
  if (layer.length > ORGANIZATION_POLICY_LIMITS.maximumPolicies) {
    issues.push(
      issue(
        "resource-limit",
        `$${name}`,
        `must contain at most ${String(ORGANIZATION_POLICY_LIMITS.maximumPolicies)} overrides`,
        {},
      ),
    );
    return { entries: [], issues };
  }
  const classified: { entry: OrganizationPolicyOverride; key: string }[] = [];
  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  for (const [index, entryValue] of layer.entries()) {
    const entryPath = `$${name}[${String(index)}]`;
    const entryRecord = snapshotPlainObject(entryValue);
    if (entryRecord === undefined) {
      issues.push(issue("invalid-value", entryPath, "override entries must be objects", {}));
      continue;
    }
    const id = entryRecord["id"];
    const sourceValue = snapshotPlainObject(entryRecord["source"]);
    if (typeof id !== "string" || sourceValue === undefined) {
      issues.push(issue("invalid-value", entryPath, "override id and source are required", {}));
      continue;
    }
    const validId = fitsSafeUtf8(id, 256) && STABLE_ID.test(id);
    if (!validId)
      issues.push(issue("invalid-value", `${entryPath}.id`, "must be a stable identifier", {}));
    let source: OrganizationPolicyOverrideSource | undefined;
    let location: ConfigurationSourceLocation | null = null;
    if (
      sourceValue["kind"] === "cli" &&
      typeof sourceValue["argument"] === "string" &&
      sourceValue["argument"].length > 0 &&
      fitsSafeUtf8(sourceValue["argument"], 256)
    ) {
      source = { argument: sourceValue["argument"], kind: "cli" };
      for (const key of Object.keys(sourceValue))
        if (!["argument", "kind"].includes(key))
          issues.push(
            issue("unknown-field", `${entryPath}.source`, "is not part of a CLI source", {}),
          );
    } else if (sourceValue["kind"] === "repository") {
      const normalizedLocation = normalizeLocation(sourceValue["location"]);
      if (normalizedLocation !== undefined) {
        location = normalizedLocation;
        source = { kind: "repository", location: normalizedLocation };
      }
      for (const key of Object.keys(sourceValue))
        if (!["kind", "location"].includes(key))
          issues.push(
            issue("unknown-field", `${entryPath}.source`, "is not part of a repository source", {}),
          );
    }
    const localOptions: OrganizationPolicyLocationProvider = { locate: () => location };
    for (const key of Object.keys(entryRecord))
      if (!["id", "source", "target", "value"].includes(key))
        issues.push(issue("unknown-field", entryPath, "is not part of an override", localOptions));
    if (source?.kind !== name)
      issues.push(
        issue("invalid-value", `${entryPath}.source`, `must be a ${name} source`, localOptions),
      );
    if (validId && seenIds.has(id))
      issues.push(
        issue("duplicate-id", `${entryPath}.id`, "duplicates an override identifier", localOptions),
      );
    if (validId) seenIds.add(id);
    const targetIssues = new BoundedIssueList();
    const target = validateTarget(
      entryRecord["target"],
      `${entryPath}.target`,
      ruleIds,
      targetIssues,
      localOptions,
    );
    issues.push(...targetIssues);
    if (target === undefined || targetIssues.length > 0) {
      continue;
    }
    const key = targetKey(target);
    const valueIssues = new BoundedIssueList();
    const value = validateValue(
      entryRecord["value"],
      target,
      `${entryPath}.value`,
      valueIssues,
      localOptions,
    );
    issues.push(...valueIssues);
    if (seenTargets.has(key))
      issues.push(
        issue(
          "duplicate-target",
          `${entryPath}.target`,
          "duplicates an override target",
          localOptions,
        ),
      );
    seenTargets.add(key);
    if (validId && source !== undefined && value !== undefined)
      classified.push({
        entry: { id, source, target, value },
        key,
      });
  }
  classified.sort(
    (left, right) => compareText(left.key, right.key) || compareText(left.entry.id, right.entry.id),
  );
  return { entries: classified.map(({ entry }) => entry), issues: sortIssues(issues) };
}

function presentOverrideLayer(layer: unknown): unknown {
  if (layer === undefined) return [];
  return layer;
}

export function resolveOrganizationPolicy(
  untrustedOptions: ResolveOrganizationPolicyOptions,
): OrganizationPolicyResolutionResult {
  const optionRecord = snapshotClosedObject(untrustedOptions, [
    "capabilities",
    "cli",
    "pack",
    "repository",
  ]);
  const optionIssues = new BoundedIssueList();
  if (optionRecord === undefined) {
    optionIssues.push(
      issue("invalid-value", "$options", "must be a closed accessor-free options object", {}),
    );
    return deepFreeze({ issues: sortIssues(optionIssues), ok: false as const });
  }
  const pack = optionRecord["pack"];
  if (pack === null || typeof pack !== "object" || !validatedOrganizationPolicyPacks.has(pack))
    optionIssues.push(
      issue(
        "invalid-value",
        "$pack",
        "must be the exact immutable value returned by successful pack validation",
        {},
      ),
    );
  if (optionIssues.length > 0)
    return deepFreeze({ issues: sortIssues(optionIssues), ok: false as const });
  const authenticatedPack = pack as ValidatedOrganizationPolicyPack;
  const capability = validateCapabilities(optionRecord["capabilities"], {});
  const capabilityIssues = capability.issues;
  if (capability.value === undefined)
    return deepFreeze({ issues: sortIssues(capabilityIssues), ok: false as const });
  const capabilities = capability.value;
  if (
    authenticatedPack.document.compatibility.ruleRegistryVersion !==
    capabilities.ruleRegistryVersion
  )
    capabilityIssues.push(
      issue(
        "unsupported-version",
        "$pack.compatibility.ruleRegistryVersion",
        "validated pack does not match the supplied engine rule registry",
        {},
      ),
    );
  if (
    (compareSemver(
      capabilities.engineVersion,
      authenticatedPack.document.compatibility.minimumEngineVersion,
    ) ?? -1) < 0
  )
    capabilityIssues.push(
      issue(
        "unsupported-version",
        "$pack.compatibility.minimumEngineVersion",
        "validated pack requires a newer engine",
        {},
      ),
    );
  for (const policy of authenticatedPack.document.policies) {
    const targetIssues = new BoundedIssueList();
    const target = validateTarget(
      policy.target,
      "$pack.target",
      capability.ruleIds,
      targetIssues,
      {},
    );
    if (target === undefined || targetIssues.length > 0)
      capabilityIssues.push({
        ...firstIssue(targetIssues),
        path: `$pack.policies.${policy.id}.target`,
      });
  }
  if (capabilityIssues.length > 0)
    return deepFreeze({ issues: sortIssues(capabilityIssues), ok: false as const });
  const repository = validateOverrideLayer(
    presentOverrideLayer(optionRecord["repository"]),
    "repository",
    capability.ruleIds,
  );
  const cli = validateOverrideLayer(
    presentOverrideLayer(optionRecord["cli"]),
    "cli",
    capability.ruleIds,
  );
  const issues = new BoundedIssueList();
  issues.push(...repository.issues, ...cli.issues);
  if (issues.length > 0) return deepFreeze({ issues: sortIssues(issues), ok: false as const });

  const assignments = new Map<string, ResolvedOrganizationPolicyAssignment>();
  const enforced = new Map<string, ResolvedOrganizationPolicyAssignment>();
  const events: OrganizationPolicyResolutionEvent[] = [];
  for (const policy of authenticatedPack.document.policies) {
    const key = targetKey(policy.target);
    const source: OrganizationPolicyAssignmentSource = {
      authority: policy.authority,
      kind: "organization",
      location: authenticatedPack.policyLocations[policy.id] ?? null,
      policyId: policy.id,
    };
    const assignment = { source, target: policy.target, targetKey: key, value: policy.value };
    assignments.set(key, assignment);
    events.push({ action: "selected", previousSource: null, source, targetKey: key });
    if (policy.authority === "enforced") enforced.set(key, assignment);
  }

  for (const layer of [repository.entries, cli.entries]) {
    for (const override of layer) {
      const key = targetKey(override.target);
      const source = sourceOfOverride(override);
      const constraint = enforced.get(key);
      if (constraint !== undefined) {
        if (!valuesEqual(constraint.value, override.value)) {
          issues.push({
            code: "conflict",
            location: locationOfSource(source),
            message: `value conflicts with enforced organization policy '${constraint.source.kind === "organization" ? constraint.source.policyId : "unknown"}'`,
            path: `$resolution.${key}`,
            relatedLocation: locationOfSource(constraint.source),
          });
        } else
          events.push({
            action: "confirmed",
            previousSource: constraint.source,
            source,
            targetKey: key,
          });
        continue;
      }
      const previous = assignments.get(key);
      assignments.set(key, {
        source,
        target: override.target,
        targetKey: key,
        value: override.value,
      });
      events.push({
        action: previous === undefined ? "selected" : "overridden",
        previousSource: previous?.source ?? null,
        source,
        targetKey: key,
      });
    }
  }
  if (issues.length > 0) return deepFreeze({ issues: sortIssues(issues), ok: false as const });
  const outputAssignments = [...assignments.values()].sort((left, right) =>
    compareText(left.targetKey, right.targetKey),
  );
  const sourceRank = (source: OrganizationPolicyAssignmentSource): number =>
    source.kind === "organization" ? 0 : source.kind === "repository" ? 1 : 2;
  events.sort(
    (left, right) =>
      compareText(left.targetKey, right.targetKey) ||
      sourceRank(left.source) - sourceRank(right.source) ||
      compareText(left.action, right.action),
  );
  return deepFreeze({
    assignments: outputAssignments,
    events,
    issues: [] as const,
    ok: true as const,
  });
}
