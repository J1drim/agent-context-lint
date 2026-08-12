import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_SNAPSHOT_LIMITS,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC,
  createInstructionIrSnapshot,
  isIssuedInstructionIrSnapshot,
  validateDiagnosticBundle,
} from "@agent-context/core";

import type {
  Diagnostic,
  DiagnosticBundle,
  DiagnosticSeverity,
  InstructionIr,
  RelatedEvidence,
  RelatedEvidenceId,
  SourceDocument,
  SuppressionRecord,
} from "@agent-context/core";
import type { RepositoryEvidenceIndex } from "@agent-context/evidence";

import {
  CONTEXT_EFFICIENCY_RULE_IDS,
  evaluateContextEfficiencyRules,
} from "./context-efficiency.js";
import type {
  ContextEfficiencyRuleInput,
  ContextEfficiencyRuleOptions,
} from "./context-efficiency.js";
import {
  CONFLICTS_DUPLICATION_RULE_IDS,
  evaluateConflictsDuplicationRules,
} from "./conflicts-duplication.js";
import type {
  ConflictsDuplicationInput,
  ConflictsDuplicationOptions,
} from "./conflicts-duplication.js";
import { DOCUMENT_CONTEXT_RULE_IDS, evaluateDocumentContextRules } from "./document-context.js";
import type { DocumentContextRuleInput, DocumentContextRuleOptions } from "./document-context.js";
import { PORTABILITY_RULE_IDS, evaluatePortabilityRules } from "./portability.js";
import type { PortabilityRuleInput, PortabilityRuleOptions } from "./portability.js";
import { REFERENCES_IMPORTS_RULE_IDS, evaluateReferencesImports } from "./references-imports.js";
import type { ReferencesImportsInput, ReferencesImportsOptions } from "./references-imports.js";
import { RULE_REGISTRY, findRuleMetadata } from "./registry.js";
import { REPOSITORY_DRIFT_RULE_IDS, evaluateRepositoryDrift } from "./repository-drift.js";
import type { RepositoryDriftOptions, RepositoryDriftStatementInput } from "./repository-drift.js";
import { SCOPE_ACTIVATION_RULE_IDS, evaluateScopeActivationRules } from "./scope-activation.js";
import type { ScopeActivationInput, ScopeActivationOptions } from "./scope-activation.js";
import { SECURITY_RULE_IDS, evaluateSecurityRules } from "./security.js";
import type { SecurityRuleInput, SecurityRuleOptions } from "./security.js";
import {
  STANDARDS_FRESHNESS_RULE_IDS,
  evaluateStandardsFreshnessRules,
} from "./standards-freshness.js";
import type { StandardsFreshnessRuleInput } from "./standards-freshness.js";
import {
  SYNTAX_STRUCTURE_RULE_IDS,
  evaluateSyntaxStructureRules,
  finalizeScheduledSyntaxSuppressions,
} from "./syntax-structure.js";
import type { SyntaxStructureRuleInput, SyntaxStructureRuleResult } from "./syntax-structure.js";

export const RULE_SCHEDULER_CONTRACT_VERSION = "0.1.0" as const;
export const RULE_SCHEDULER_RECORD_KIND = "agent-context-rule-scheduler-input" as const;

export type RuleFamilyId =
  | "conflicts-duplication"
  | "context-efficiency"
  | "document-context"
  | "portability"
  | "references-imports"
  | "repository-drift"
  | "scope-activation"
  | "security"
  | "standards-freshness"
  | "syntax-structure";

export const RULE_FAMILY_IDS: readonly RuleFamilyId[] = Object.freeze([
  "conflicts-duplication",
  "context-efficiency",
  "document-context",
  "portability",
  "references-imports",
  "repository-drift",
  "scope-activation",
  "security",
  "standards-freshness",
  "syntax-structure",
]);

export interface RuleFamilyDescriptor {
  readonly dependencies: readonly RuleFamilyId[];
  readonly familyId: RuleFamilyId;
  readonly ruleIds: readonly string[];
  readonly ticketId: `F${number}`;
}

const SYNTAX_DEPENDENCY = Object.freeze(["syntax-structure"] as const);

export const RULE_FAMILY_DESCRIPTORS: readonly RuleFamilyDescriptor[] = Object.freeze([
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "conflicts-duplication",
    ruleIds: Object.freeze([...CONFLICTS_DUPLICATION_RULE_IDS]),
    ticketId: "F08",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "context-efficiency",
    ruleIds: Object.freeze([...CONTEXT_EFFICIENCY_RULE_IDS]),
    ticketId: "F14",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "document-context",
    ruleIds: Object.freeze([...DOCUMENT_CONTEXT_RULE_IDS]),
    ticketId: "F10",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "portability",
    ruleIds: Object.freeze([...PORTABILITY_RULE_IDS]),
    ticketId: "F12",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "references-imports",
    ruleIds: Object.freeze([...REFERENCES_IMPORTS_RULE_IDS]),
    ticketId: "F06",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "repository-drift",
    ruleIds: Object.freeze([...REPOSITORY_DRIFT_RULE_IDS]),
    ticketId: "F09",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "scope-activation",
    ruleIds: Object.freeze([...SCOPE_ACTIVATION_RULE_IDS]),
    ticketId: "F07",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "security",
    ruleIds: Object.freeze([...SECURITY_RULE_IDS]),
    ticketId: "F11",
  }),
  Object.freeze({
    dependencies: SYNTAX_DEPENDENCY,
    familyId: "standards-freshness",
    ruleIds: Object.freeze([...STANDARDS_FRESHNESS_RULE_IDS]),
    ticketId: "F13",
  }),
  Object.freeze({
    dependencies: Object.freeze([]),
    familyId: "syntax-structure",
    ruleIds: Object.freeze([...SYNTAX_STRUCTURE_RULE_IDS]),
    ticketId: "F05",
  }),
]);

export interface SyntaxStructureFamilyRequest {
  readonly familyId: "syntax-structure";
  readonly input: SyntaxStructureRuleInput;
  readonly options: undefined;
}
export interface ReferencesImportsFamilyRequest {
  readonly familyId: "references-imports";
  readonly input: ReferencesImportsInput;
  readonly options: ReferencesImportsOptions | undefined;
}
export interface ScopeActivationFamilyRequest {
  readonly familyId: "scope-activation";
  readonly input: ScopeActivationInput;
  readonly options: ScopeActivationOptions | undefined;
}
export interface ConflictsDuplicationFamilyRequest {
  readonly familyId: "conflicts-duplication";
  readonly input: ConflictsDuplicationInput;
  readonly options: ConflictsDuplicationOptions | undefined;
}
export interface RepositoryDriftFamilyInput {
  readonly evidenceIndex: RepositoryEvidenceIndex;
  readonly statements: readonly RepositoryDriftStatementInput[];
}
export interface RepositoryDriftFamilyRequest {
  readonly familyId: "repository-drift";
  readonly input: RepositoryDriftFamilyInput;
  readonly options: RepositoryDriftOptions | undefined;
}
export interface DocumentContextFamilyRequest {
  readonly familyId: "document-context";
  readonly input: DocumentContextRuleInput;
  readonly options: DocumentContextRuleOptions | undefined;
}
export interface SecurityFamilyRequest {
  readonly familyId: "security";
  readonly input: SecurityRuleInput;
  readonly options: SecurityRuleOptions | undefined;
}
export interface PortabilityFamilyRequest {
  readonly familyId: "portability";
  readonly input: PortabilityRuleInput;
  readonly options: PortabilityRuleOptions | undefined;
}
export interface StandardsFreshnessFamilyRequest {
  readonly familyId: "standards-freshness";
  readonly input: StandardsFreshnessRuleInput;
  readonly options: undefined;
}
export interface ContextEfficiencyFamilyRequest {
  readonly familyId: "context-efficiency";
  readonly input: ContextEfficiencyRuleInput;
  readonly options: ContextEfficiencyRuleOptions | undefined;
}

export type RuleFamilyRequest =
  | ConflictsDuplicationFamilyRequest
  | ContextEfficiencyFamilyRequest
  | DocumentContextFamilyRequest
  | PortabilityFamilyRequest
  | ReferencesImportsFamilyRequest
  | RepositoryDriftFamilyRequest
  | ScopeActivationFamilyRequest
  | SecurityFamilyRequest
  | StandardsFreshnessFamilyRequest
  | SyntaxStructureFamilyRequest;

export type RuleSchedulerFailureThreshold = "error" | "never" | "warning";
export type RuleSchedulerSeverity = DiagnosticSeverity | "off";

export interface RuleSchedulerPolicy {
  readonly failureThreshold: RuleSchedulerFailureThreshold;
  readonly severityOverrides: Readonly<Record<string, RuleSchedulerSeverity>>;
}
export interface RuleSchedulerInput {
  readonly contractVersion: typeof RULE_SCHEDULER_CONTRACT_VERSION;
  readonly families: readonly RuleFamilyRequest[];
  readonly policy: RuleSchedulerPolicy;
  readonly recordKind: typeof RULE_SCHEDULER_RECORD_KIND;
}
export interface RuleSchedulerLimits {
  readonly maximumConcurrency: number;
  readonly maximumDiagnostics: number;
  readonly maximumDurationMs: number;
  readonly scheduleSeed: number;
}
export interface RuleSchedulerOptions extends Partial<RuleSchedulerLimits> {
  readonly signal?: AbortSignal | undefined;
}

export const RULE_SCHEDULER_DEFAULT_LIMITS: Readonly<RuleSchedulerLimits> = Object.freeze({
  maximumConcurrency: 4,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumDurationMs: 30_000,
  scheduleSeed: 0,
});
export const RULE_SCHEDULER_HARD_LIMITS: Readonly<RuleSchedulerLimits> = Object.freeze({
  maximumConcurrency: RULE_FAMILY_IDS.length,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumDurationMs: 300_000,
  scheduleSeed: 0xffff_ffff,
});

export type RuleSchedulerIssueCode =
  | "cancelled"
  | "deadline-exceeded"
  | "dependency-failure"
  | "family-failure"
  | "invalid-input"
  | "invalid-options"
  | "invalid-output"
  | "resource-limit";
export interface RuleSchedulerIssue {
  readonly code: RuleSchedulerIssueCode;
  readonly familyId: RuleFamilyId | null;
  readonly message: string;
  readonly path: string;
}
export interface RuleFamilySummary {
  readonly diagnosticCount: number;
  readonly familyId: RuleFamilyId;
  readonly ticketId: `F${number}`;
}
export interface RuleSchedulerSummary {
  readonly active: Readonly<Record<DiagnosticSeverity, number>>;
  readonly diagnosticCount: number;
  readonly failureThreshold: RuleSchedulerFailureThreshold;
  readonly shouldFail: boolean;
  readonly suppressedCount: number;
}
export interface RuleSchedulerSuccess {
  readonly bundle: DiagnosticBundle;
  readonly contractVersion: typeof RULE_SCHEDULER_CONTRACT_VERSION;
  readonly executionOrder: readonly RuleFamilyId[];
  readonly families: readonly RuleFamilySummary[];
  readonly limits: RuleSchedulerLimits;
  readonly ok: true;
  readonly recordKind: "agent-context-rule-scheduler-result";
  readonly sources: readonly SourceDocument[];
  readonly summary: RuleSchedulerSummary;
  readonly suppressedDiagnostics: readonly Diagnostic[];
  readonly visibleDiagnostics: readonly Diagnostic[];
}
export type RuleSchedulerResult =
  RuleSchedulerSuccess | { readonly issues: readonly RuleSchedulerIssue[]; readonly ok: false };
export type RuleDiagnosticCanonicalizationResult =
  | { readonly bundle: DiagnosticBundle; readonly ok: true }
  | { readonly issues: readonly RuleSchedulerIssue[]; readonly ok: false };

const ISSUED_RULE_SCHEDULER_SUCCESSES = new WeakSet<object>();

/** True only for complete scheduler results produced by this process's F15 implementation. */
export function isIssuedRuleSchedulerSuccess(value: unknown): value is RuleSchedulerSuccess {
  return typeof value === "object" && value !== null && ISSUED_RULE_SCHEDULER_SUCCESSES.has(value);
}

type DataRecord = Readonly<Record<string, unknown>>;
interface NormalizedOptions {
  readonly limits: RuleSchedulerLimits;
  readonly signal: AbortSignal | undefined;
}
interface NormalizedInput {
  readonly policy: RuleSchedulerPolicy;
  readonly requests: ReadonlyMap<RuleFamilyId, RuleFamilyRequest>;
  readonly snapshotIr: InstructionIr;
}
interface FamilyExecution {
  readonly bundle: DiagnosticBundle;
  readonly diagnosticCount: number;
  readonly familyId: RuleFamilyId;
  readonly sources: readonly SourceDocument[] | null;
  readonly syntaxEvaluation: SyntaxStructureRuleResult | null;
}

const FAMILY_IDS = new Set<string>(RULE_FAMILY_IDS);
const FAMILY_BY_ID = new Map(RULE_FAMILY_DESCRIPTORS.map((entry) => [entry.familyId, entry]));
const REQUEST_KEYS = new Set(["familyId", "input", "options"]);
const INPUT_KEYS = new Set(["contractVersion", "families", "policy", "recordKind"]);
const POLICY_KEYS = new Set(["failureThreshold", "severityOverrides"]);
const REPOSITORY_DRIFT_REQUEST_INPUT_KEYS = new Set(["evidenceIndex", "statements"]);
const REPOSITORY_DRIFT_STATEMENT_KEYS = new Set([
  "dialect",
  "documentId",
  "nodeIds",
  "path",
  "range",
  "sourceDigest",
  "statementId",
  "text",
]);
const OPTION_KEYS = new Set([
  "maximumConcurrency",
  "maximumDiagnostics",
  "maximumDurationMs",
  "scheduleSeed",
  "signal",
]);
const SEVERITIES = new Set<string>(["error", "info", "off", "warning"]);
const FAILURE_THRESHOLDS = new Set<string>(["error", "never", "warning"]);
const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({
  error: 3,
  info: 1,
  warning: 2,
});
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function schedulerIssue(
  code: RuleSchedulerIssueCode,
  path: string,
  message: string,
  familyId: RuleFamilyId | null = null,
): RuleSchedulerIssue {
  return Object.freeze({ code, familyId, message, path });
}
function schedulerFailure(value: RuleSchedulerIssue): RuleSchedulerResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}
function canonicalizationFailure(value: RuleSchedulerIssue): RuleDiagnosticCanonicalizationResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function dataRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  path: string,
  code: "invalid-input" | "invalid-options" = "invalid-input",
): DataRecord | RuleSchedulerIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return schedulerIssue(code, path, "must be a non-proxy plain data record");
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const actual = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      actual.length !== keys.size ||
      actual.some((key) => typeof key !== "string" || !keys.has(key))
    )
      return schedulerIssue(code, path, "has unknown or missing fields");
    const output: Record<string, unknown> = {};
    for (const key of actual) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return schedulerIssue(code, path, "must contain only enumerable own data fields");
      output[key as string] = descriptor.value;
    }
    return output;
  } catch {
    return schedulerIssue(code, path, "cannot be inspected safely");
  }
}

function denseArray(
  value: unknown,
  maximum: number,
  path: string,
): readonly unknown[] | RuleSchedulerIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return schedulerIssue("invalid-input", path, "must be a regular dense array");
  if (value.length > maximum)
    return schedulerIssue("resource-limit", path, "exceeds its hard item limit");
  try {
    if (Reflect.ownKeys(value).length !== value.length + 1)
      return schedulerIssue("invalid-input", path, "must be dense and unextended");
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return schedulerIssue("invalid-input", path, "must contain only own data entries");
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return schedulerIssue("invalid-input", path, "cannot be inspected safely");
  }
}

function isIssue(value: unknown): value is RuleSchedulerIssue {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    "familyId" in value &&
    "message" in value &&
    "path" in value
  );
}

function abortState(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  if (ABORTED_GETTER === undefined) return undefined;
  try {
    const state: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptions(raw: unknown): NormalizedOptions | RuleSchedulerIssue {
  if (raw === undefined)
    return Object.freeze({ limits: RULE_SCHEDULER_DEFAULT_LIMITS, signal: undefined });
  if (raw === null || typeof raw !== "object" || nodeTypes.isProxy(raw) || Array.isArray(raw))
    return schedulerIssue("invalid-options", "$options", "must be a plain data record");
  let actual: readonly PropertyKey[];
  try {
    if (Reflect.getPrototypeOf(raw) !== Object.prototype && Reflect.getPrototypeOf(raw) !== null)
      return schedulerIssue("invalid-options", "$options", "must be a plain data record");
    actual = Reflect.ownKeys(raw);
  } catch {
    return schedulerIssue("invalid-options", "$options", "cannot be inspected safely");
  }
  if (actual.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key)))
    return schedulerIssue("invalid-options", "$options", "contains an unknown field");
  const values = new Map<string, unknown>();
  for (const key of actual) {
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return schedulerIssue("invalid-options", "$options", "must contain only own data fields");
    values.set(key as string, descriptor.value);
  }
  const selected = { ...RULE_SCHEDULER_DEFAULT_LIMITS };
  for (const key of [
    "maximumConcurrency",
    "maximumDiagnostics",
    "maximumDurationMs",
    "scheduleSeed",
  ] as const) {
    if (!values.has(key)) continue;
    const value = values.get(key);
    const minimum = key === "scheduleSeed" ? 0 : 1;
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < minimum ||
      (value as number) > RULE_SCHEDULER_HARD_LIMITS[key]
    )
      return schedulerIssue("invalid-options", `$options.${key}`, "is outside its hard limit");
    selected[key] = value as number;
  }
  let signal: AbortSignal | undefined;
  if (values.has("signal")) {
    const candidate = values.get("signal");
    if (candidate !== undefined) {
      if (abortState(candidate) === undefined)
        return schedulerIssue("invalid-options", "$options.signal", "must be a native AbortSignal");
      signal = candidate as AbortSignal;
    }
  }
  return Object.freeze({ limits: Object.freeze(selected), signal });
}

function normalizePolicy(raw: unknown): RuleSchedulerPolicy | RuleSchedulerIssue {
  const record = dataRecord(raw, POLICY_KEYS, "$.policy");
  if (isIssue(record)) return record;
  const threshold = record["failureThreshold"];
  if (typeof threshold !== "string" || !FAILURE_THRESHOLDS.has(threshold))
    return schedulerIssue("invalid-input", "$.policy.failureThreshold", "is unsupported");
  const overrides = record["severityOverrides"];
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    nodeTypes.isProxy(overrides) ||
    Array.isArray(overrides)
  )
    return schedulerIssue("invalid-input", "$.policy.severityOverrides", "must be a data record");
  const normalized: Record<string, RuleSchedulerSeverity> = Object.create(null) as Record<
    string,
    RuleSchedulerSeverity
  >;
  try {
    const prototype = Reflect.getPrototypeOf(overrides);
    const keys = Reflect.ownKeys(overrides);
    if (prototype !== Object.prototype && prototype !== null)
      return schedulerIssue("invalid-input", "$.policy.severityOverrides", "must be plain data");
    if (keys.length > RULE_REGISTRY.rules.length)
      return schedulerIssue("resource-limit", "$.policy.severityOverrides", "has too many rules");
    for (const key of keys) {
      if (typeof key !== "string" || findRuleMetadata(key) === undefined)
        return schedulerIssue(
          "invalid-input",
          "$.policy.severityOverrides",
          "names an unknown rule",
        );
      const descriptor = Reflect.getOwnPropertyDescriptor(overrides, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return schedulerIssue("invalid-input", `$.policy.severityOverrides.${key}`, "must be data");
      if (typeof descriptor.value !== "string" || !SEVERITIES.has(descriptor.value))
        return schedulerIssue(
          "invalid-input",
          `$.policy.severityOverrides.${key}`,
          "is unsupported",
        );
      normalized[key] = descriptor.value as RuleSchedulerSeverity;
    }
  } catch {
    return schedulerIssue(
      "invalid-input",
      "$.policy.severityOverrides",
      "cannot be inspected safely",
    );
  }
  return Object.freeze({
    failureThreshold: threshold as RuleSchedulerFailureThreshold,
    severityOverrides: Object.freeze(normalized),
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreezeData<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreezeData(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function rebindIr(
  input: unknown,
  ir: InstructionIr,
  path: string,
): DataRecord | RuleSchedulerIssue {
  if (
    input === null ||
    typeof input !== "object" ||
    nodeTypes.isProxy(input) ||
    Array.isArray(input)
  )
    return schedulerIssue("invalid-input", path, "must be a non-proxy plain data record");
  try {
    const prototype = Reflect.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      return schedulerIssue("invalid-input", path, "must be a plain data record");
    const output: Record<string, unknown> = {};
    let foundIr = false;
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        return schedulerIssue(
          "invalid-input",
          path,
          "must contain only enumerable own data fields",
        );
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: key === "ir" ? ir : descriptor.value,
        writable: false,
      });
      if (key === "ir") foundIr = true;
    }
    if (!foundIr) return schedulerIssue("invalid-input", `${path}.ir`, "must be an own data field");
    return Object.freeze(output);
  } catch {
    return schedulerIssue("invalid-input", path, "cannot be inspected safely");
  }
}

function exactOwnRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): DataRecord | RuleSchedulerIssue {
  return dataRecord(value, new Set(keys), path);
}

function exactNodeIds(
  value: unknown,
  expected: InstructionIr["statements"][number]["nodeIds"],
  path: string,
): true | RuleSchedulerIssue {
  const entries = denseArray(
    value,
    INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStatementNodeReferences,
    path,
  );
  if (isIssue(entries)) return entries;
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => typeof entry !== "string" || entry !== expected[index])
  )
    return schedulerIssue(
      "dependency-failure",
      path,
      "must exactly match the engine-owned B03 statement node references",
      "repository-drift",
    );
  return true;
}

function exactPosition(
  value: unknown,
  expected: InstructionIr["statements"][number]["range"]["start"],
  path: string,
): true | RuleSchedulerIssue {
  const position = exactOwnRecord(
    value,
    ["byteOffset", "line", "utf16Column", "utf16Offset"],
    path,
  );
  if (isIssue(position)) return position;
  if (
    position["byteOffset"] !== expected.byteOffset ||
    position["line"] !== expected.line ||
    position["utf16Column"] !== expected.utf16Column ||
    position["utf16Offset"] !== expected.utf16Offset
  )
    return schedulerIssue(
      "dependency-failure",
      path,
      "must exactly match the engine-owned B03 statement position",
      "repository-drift",
    );
  return true;
}

function exactRange(
  value: unknown,
  expected: InstructionIr["statements"][number]["range"],
  path: string,
): true | RuleSchedulerIssue {
  const range = exactOwnRecord(value, ["end", "sourceId", "start"], path);
  if (isIssue(range)) return range;
  if (range["sourceId"] !== expected.sourceId)
    return schedulerIssue(
      "dependency-failure",
      `${path}.sourceId`,
      "must exactly match the engine-owned B03 statement source",
      "repository-drift",
    );
  const start = exactPosition(range["start"], expected.start, `${path}.start`);
  if (isIssue(start)) return start;
  return exactPosition(range["end"], expected.end, `${path}.end`);
}

function snapshotDriftStatements(
  value: unknown,
  ir: InstructionIr,
): readonly RepositoryDriftStatementInput[] | RuleSchedulerIssue {
  const entries = denseArray(
    value,
    INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStatements,
    "$.families.repository-drift.input.statements",
  );
  if (isIssue(entries)) return entries;
  const statementById = new Map<string, InstructionIr["statements"][number]>(
    ir.statements.map((statement) => [statement.id, statement]),
  );
  const documentById = new Map<string, InstructionIr["documents"][number]>(
    ir.documents.map((document) => [document.id, document]),
  );
  const sourceById = new Map<string, InstructionIr["sources"][number]>(
    ir.sources.map((source) => [source.id, source]),
  );
  const seen = new Set<string>();
  const output: RepositoryDriftStatementInput[] = [];
  for (const [index, valueEntry] of entries.entries()) {
    const path = `$.families.repository-drift.input.statements[${String(index)}]`;
    const entry = dataRecord(valueEntry, REPOSITORY_DRIFT_STATEMENT_KEYS, path);
    if (isIssue(entry)) return entry;
    const statementId = entry["statementId"];
    const statement = typeof statementId === "string" ? statementById.get(statementId) : undefined;
    const document = statement === undefined ? undefined : documentById.get(statement.documentId);
    const source = document === undefined ? undefined : sourceById.get(document.sourceId);
    const nodeIds =
      statement === undefined
        ? schedulerIssue(
            "dependency-failure",
            `${path}.nodeIds`,
            "references an unknown statement",
            "repository-drift",
          )
        : exactNodeIds(entry["nodeIds"], statement.nodeIds, `${path}.nodeIds`);
    if (isIssue(nodeIds)) return nodeIds;
    const range =
      statement === undefined
        ? schedulerIssue(
            "dependency-failure",
            `${path}.range`,
            "references an unknown statement",
            "repository-drift",
          )
        : exactRange(entry["range"], statement.range, `${path}.range`);
    if (isIssue(range)) return range;
    if (
      statement === undefined ||
      document === undefined ||
      source === undefined ||
      seen.has(statement.id) ||
      entry["documentId"] !== statement.documentId ||
      entry["path"] !== source.path ||
      entry["sourceDigest"] !== source.sha256 ||
      entry["text"] !== statement.text
    )
      return schedulerIssue(
        "dependency-failure",
        path,
        "must exactly match one statement in the engine-owned B03 snapshot",
        "repository-drift",
      );
    seen.add(statement.id);
    output.push(
      Object.freeze({
        dialect: entry["dialect"] as RepositoryDriftStatementInput["dialect"],
        documentId: statement.documentId,
        nodeIds: statement.nodeIds,
        path: source.path,
        range: statement.range,
        sourceDigest: source.sha256,
        statementId: statement.id,
        text: statement.text,
      }),
    );
  }
  if (seen.size !== ir.statements.length)
    return schedulerIssue(
      "dependency-failure",
      "$.families.repository-drift.input.statements",
      "must cover every statement in the engine-owned B03 snapshot exactly once",
      "repository-drift",
    );
  return Object.freeze(
    output.sort((left, right) => compareUtf8(left.statementId, right.statementId)),
  );
}

function normalizeInput(raw: unknown): NormalizedInput | RuleSchedulerIssue {
  const record = dataRecord(raw, INPUT_KEYS, "$input");
  if (isIssue(record)) return record;
  if (
    record["recordKind"] !== RULE_SCHEDULER_RECORD_KIND ||
    record["contractVersion"] !== RULE_SCHEDULER_CONTRACT_VERSION
  )
    return schedulerIssue("invalid-input", "$input", "kind or contract version is unsupported");
  const policy = normalizePolicy(record["policy"]);
  if (isIssue(policy)) return policy;
  const values = denseArray(record["families"], RULE_FAMILY_IDS.length, "$.families");
  if (isIssue(values)) return values;
  if (values.length === 0)
    return schedulerIssue("invalid-input", "$.families", "must select at least one rule family");
  const rawRequests = new Map<RuleFamilyId, RuleFamilyRequest>();
  let exactIr: unknown;
  for (const [index, value] of values.entries()) {
    const path = `$.families[${String(index)}]`;
    const request = dataRecord(value, REQUEST_KEYS, path);
    if (isIssue(request)) return request;
    const familyId = request["familyId"];
    if (typeof familyId !== "string" || !FAMILY_IDS.has(familyId))
      return schedulerIssue("invalid-input", `${path}.familyId`, "is not a built-in family");
    if (rawRequests.has(familyId as RuleFamilyId))
      return schedulerIssue("invalid-input", `${path}.familyId`, "duplicates a family request");
    if (typeof request["input"] === "function" || typeof request["options"] === "function")
      return schedulerIssue("invalid-input", path, "must not contain an executable capability");
    if (
      request["options"] !== undefined &&
      (request["options"] === null ||
        typeof request["options"] !== "object" ||
        nodeTypes.isProxy(request["options"]))
    )
      return schedulerIssue("invalid-input", `${path}.options`, "must be non-proxy plain data");
    if (
      (familyId === "syntax-structure" || familyId === "standards-freshness") &&
      request["options"] !== undefined
    )
      return schedulerIssue(
        "invalid-input",
        `${path}.options`,
        "must be undefined for this family",
      );
    if (familyId === "repository-drift") {
      const drift = dataRecord(
        request["input"],
        REPOSITORY_DRIFT_REQUEST_INPUT_KEYS,
        `${path}.input`,
      );
      if (isIssue(drift)) return drift;
    }
    const input = request["input"];
    if (input === null || typeof input !== "object" || nodeTypes.isProxy(input))
      return schedulerIssue("invalid-input", `${path}.input`, "must be non-proxy plain data");
    if (familyId !== "repository-drift") {
      const irDescriptor = Reflect.getOwnPropertyDescriptor(input, "ir");
      if (irDescriptor === undefined || !irDescriptor.enumerable || !("value" in irDescriptor))
        return schedulerIssue("invalid-input", `${path}.input.ir`, "must be an own data field");
      if (familyId === "syntax-structure") exactIr = irDescriptor.value;
    }
    rawRequests.set(familyId as RuleFamilyId, request as unknown as RuleFamilyRequest);
  }
  if (!rawRequests.has("syntax-structure") || exactIr === undefined)
    return schedulerIssue(
      "dependency-failure",
      "$.families",
      "syntax-structure is required as the source and suppression authority",
      "syntax-structure",
    );
  for (const [familyId, request] of rawRequests) {
    if (familyId === "repository-drift") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(request.input, "ir");
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== exactIr)
      return schedulerIssue(
        "dependency-failure",
        `$.families.${familyId}.input.ir`,
        "must be the exact F05 B03 snapshot object",
        familyId,
      );
  }
  let snapshotIr: InstructionIr;
  if (isIssuedInstructionIrSnapshot(exactIr)) snapshotIr = exactIr;
  else {
    const snapshot = createInstructionIrSnapshot(exactIr);
    if (!snapshot.ok)
      return schedulerIssue(
        snapshot.issues[0]?.code === "resource-limit" ? "resource-limit" : "invalid-input",
        "$.families.syntax-structure.input.ir",
        "could not create a bounded engine-owned B03 snapshot",
        "syntax-structure",
      );
    snapshotIr = snapshot.value;
  }
  const requests = new Map<RuleFamilyId, RuleFamilyRequest>();
  for (const [familyId, request] of rawRequests) {
    if (familyId === "repository-drift") {
      const inputRecord = dataRecord(
        request.input,
        REPOSITORY_DRIFT_REQUEST_INPUT_KEYS,
        "$.families.repository-drift.input",
      );
      if (isIssue(inputRecord)) return inputRecord;
      const statements = snapshotDriftStatements(inputRecord["statements"], snapshotIr);
      if (isIssue(statements)) return statements;
      requests.set(
        familyId,
        Object.freeze({
          familyId,
          input: Object.freeze({ evidenceIndex: inputRecord["evidenceIndex"], statements }),
          options: request.options,
        }) as RepositoryDriftFamilyRequest,
      );
      continue;
    }
    const rebound = rebindIr(request.input, snapshotIr, `$.families.${familyId}.input`);
    if (isIssue(rebound)) return rebound;
    requests.set(
      familyId,
      Object.freeze({
        familyId,
        input: rebound,
        options: request.options,
      }) as unknown as RuleFamilyRequest,
    );
  }
  return Object.freeze({
    policy,
    requests,
    snapshotIr,
  });
}

function compareLocations(left: Diagnostic["primary"], right: Diagnostic["primary"]): number {
  return (
    compareUtf8(left.path, right.path) ||
    left.range.start.byteOffset - right.range.start.byteOffset ||
    left.range.end.byteOffset - right.range.end.byteOffset ||
    compareUtf8(left.sourceId, right.sourceId)
  );
}
function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareLocations(left.primary, right.primary) ||
    compareUtf8(left.ruleId, right.ruleId) ||
    compareUtf8(left.fingerprints.path.value, right.fingerprints.path.value) ||
    compareUtf8(left.fingerprints.semantic.value, right.fingerprints.semantic.value) ||
    compareUtf8(left.id, right.id)
  );
}
function compareSuppressions(left: SuppressionRecord, right: SuppressionRecord): number {
  return compareLocations(left.directive, right.directive) || compareUtf8(left.id, right.id);
}
function deduplicationKey(diagnostic: Diagnostic): string {
  return `${diagnostic.fingerprints.path.value}\u0000${diagnostic.fingerprints.semantic.value}`;
}
function evidenceIdForPrimary(diagnostic: Diagnostic): RelatedEvidenceId {
  const digest = createHash("sha256")
    .update(canonicalJson(diagnostic.primary), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `evidence:scheduler:${digest}` as RelatedEvidenceId;
}

function mergeDiagnosticGroup(diagnostics: readonly Diagnostic[]): Diagnostic | RuleSchedulerIssue {
  const ordered = [...diagnostics].sort((left, right) => compareUtf8(left.id, right.id));
  const first = ordered[0];
  if (first === undefined)
    return schedulerIssue("invalid-output", "$output.diagnostics", "contains an empty group");
  const identity = canonicalJson({
    fingerprintBasis: first.fingerprintBasis,
    fingerprints: first.fingerprints,
    ruleId: first.ruleId,
    ruleVersion: first.ruleVersion,
  });
  if (
    ordered.some(
      (entry) =>
        canonicalJson({
          fingerprintBasis: entry.fingerprintBasis,
          fingerprints: entry.fingerprints,
          ruleId: entry.ruleId,
          ruleVersion: entry.ruleVersion,
        }) !== identity,
    )
  )
    return schedulerIssue(
      "invalid-output",
      "$output.diagnostics",
      "a fingerprint collision has incompatible identity data",
    );
  if (ordered.some((entry) => entry.message !== first.message))
    return schedulerIssue(
      "invalid-output",
      "$output.diagnostics.message",
      "fingerprint duplicates contain different messages",
    );
  const primary = [...ordered].sort((left, right) =>
    compareLocations(left.primary, right.primary),
  )[0]?.primary;
  if (primary === undefined)
    return schedulerIssue("invalid-output", "$output.diagnostics", "has no primary location");
  const evidenceById = new Map<string, RelatedEvidence>();
  const addEvidence = (evidence: RelatedEvidence): RuleSchedulerIssue | undefined => {
    const previous = evidenceById.get(evidence.id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(evidence))
      return schedulerIssue(
        "invalid-output",
        "$output.diagnostics.related",
        "reuses a related-evidence ID for different evidence",
      );
    evidenceById.set(evidence.id, evidence);
    return undefined;
  };
  for (const entry of ordered) {
    for (const evidence of entry.related) {
      const problem = addEvidence(evidence);
      if (problem !== undefined) return problem;
    }
    if (compareLocations(entry.primary, primary) !== 0) {
      const problem = addEvidence(
        Object.freeze({
          id: evidenceIdForPrimary(entry),
          kind: "source" as const,
          label: "Duplicate diagnostic primary evidence",
          location: entry.primary,
        }),
      );
      if (problem !== undefined) return problem;
    }
  }
  const semanticEvidence = new Map<string, RelatedEvidence>();
  for (const evidence of evidenceById.values()) {
    const key = canonicalJson({ ...evidence, id: "" });
    const previous = semanticEvidence.get(key);
    if (previous === undefined || compareUtf8(evidence.id, previous.id) < 0)
      semanticEvidence.set(key, evidence);
  }
  if (semanticEvidence.size > MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC)
    return schedulerIssue(
      "resource-limit",
      "$output.diagnostics.related",
      "merged evidence exceeds the B04 per-diagnostic limit",
    );
  const related = Object.freeze(
    [...semanticEvidence.values()].sort(
      (left, right) =>
        compareUtf8(left.id, right.id) || compareUtf8(canonicalJson(left), canonicalJson(right)),
    ),
  );
  const severity = ordered.reduce<DiagnosticSeverity>(
    (highest, entry) =>
      SEVERITY_RANK[entry.severity] > SEVERITY_RANK[highest] ? entry.severity : highest,
    "info",
  );
  const suggestionIdentities = ordered.map((entry) => canonicalJson(entry.suggestion));
  if (new Set(suggestionIdentities).size > 1)
    return schedulerIssue(
      "invalid-output",
      "$output.diagnostics.suggestion",
      "fingerprint duplicates propose different suggestions or fix plans",
    );
  return Object.freeze({
    ...first,
    primary,
    related,
    severity,
    suggestion: first.suggestion,
  });
}

function applySeverity(diagnostic: Diagnostic, policy: RuleSchedulerPolicy): Diagnostic | null {
  const selected = policy.severityOverrides[diagnostic.ruleId];
  if (selected === "off") return null;
  if (selected === undefined || selected === diagnostic.severity) return diagnostic;
  return Object.freeze({ ...diagnostic, severity: selected });
}

function policyFilteredBundle(
  rawBundle: unknown,
  sources: readonly SourceDocument[],
  policy: RuleSchedulerPolicy,
): RuleDiagnosticCanonicalizationResult {
  const checked = validateDiagnosticBundle(rawBundle, sources);
  if (!checked.ok)
    return canonicalizationFailure(
      schedulerIssue("invalid-output", "$output", "does not satisfy the B04 diagnostic contract"),
    );
  const diagnostics: Diagnostic[] = [];
  for (const original of checked.value.diagnostics) {
    if (findRuleMetadata(original.ruleId) === undefined)
      return canonicalizationFailure(
        schedulerIssue("invalid-output", "$output.diagnostics", "contains an unregistered rule"),
      );
    const selected = applySeverity(original, policy);
    if (selected !== null) diagnostics.push(selected);
  }
  const candidate: DiagnosticBundle = Object.freeze({
    ...checked.value,
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
    suppressions: Object.freeze([...checked.value.suppressions].sort(compareSuppressions)),
  });
  const validated = validateDiagnosticBundle(candidate, sources);
  return validated.ok
    ? Object.freeze({ bundle: validated.value, ok: true })
    : canonicalizationFailure(
        schedulerIssue("invalid-output", "$output", "policy output failed B04 validation"),
      );
}

/** Validate, severity-filter, fingerprint-deduplicate, evidence-merge, and sort B04 data. */
export function canonicalizeRuleDiagnostics(
  rawBundle: unknown,
  sources: readonly SourceDocument[],
  rawPolicy: unknown,
): RuleDiagnosticCanonicalizationResult {
  const policy = normalizePolicy(rawPolicy);
  if (isIssue(policy)) return canonicalizationFailure(policy);
  const filtered = policyFilteredBundle(rawBundle, sources, policy);
  if (!filtered.ok) return filtered;
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of filtered.bundle.diagnostics) {
    const entries = groups.get(deduplicationKey(diagnostic)) ?? [];
    entries.push(diagnostic);
    groups.set(deduplicationKey(diagnostic), entries);
  }
  const diagnostics: Diagnostic[] = [];
  for (const key of [...groups.keys()].sort(compareUtf8)) {
    const merged = mergeDiagnosticGroup(groups.get(key) ?? []);
    if (isIssue(merged)) return canonicalizationFailure(merged);
    diagnostics.push(merged);
  }
  const candidate: DiagnosticBundle = Object.freeze({
    ...filtered.bundle,
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
  });
  const validated = validateDiagnosticBundle(candidate, sources);
  if (!validated.ok)
    return canonicalizationFailure(
      schedulerIssue("invalid-output", "$output", "canonical output failed B04 validation"),
    );
  try {
    const detached = deepFreezeData(structuredClone(validated.value));
    return Object.freeze({ bundle: detached, ok: true });
  } catch {
    return canonicalizationFailure(
      schedulerIssue("invalid-output", "$output", "canonical output could not be detached safely"),
    );
  }
}

function topologicalLevels(
  requests: ReadonlyMap<RuleFamilyId, RuleFamilyRequest>,
): readonly (readonly RuleFamilyId[])[] {
  const remaining = new Set(requests.keys());
  const completed = new Set<RuleFamilyId>();
  const levels: RuleFamilyId[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((familyId) =>
        (FAMILY_BY_ID.get(familyId)?.dependencies ?? []).every((dependency) =>
          completed.has(dependency),
        ),
      )
      .sort(compareUtf8);
    if (ready.length === 0) return Object.freeze([]);
    levels.push(ready);
    for (const familyId of ready) {
      remaining.delete(familyId);
      completed.add(familyId);
    }
  }
  return Object.freeze(levels.map((level) => Object.freeze(level)));
}

function resultBundle(value: unknown): DiagnosticBundle | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "bundle");
  return descriptor !== undefined && "value" in descriptor
    ? (descriptor.value as DiagnosticBundle)
    : undefined;
}
function resultSources(value: unknown): readonly SourceDocument[] | null {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "sources");
  return descriptor !== undefined && "value" in descriptor && Array.isArray(descriptor.value)
    ? (descriptor.value as readonly SourceDocument[])
    : null;
}
function failedResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "ok");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === false;
}

function runFamily(request: RuleFamilyRequest): FamilyExecution | RuleSchedulerIssue {
  try {
    let result: unknown;
    switch (request.familyId) {
      case "syntax-structure":
        result = evaluateSyntaxStructureRules(request.input);
        break;
      case "references-imports":
        result = evaluateReferencesImports(request.input, request.options);
        break;
      case "scope-activation":
        result = evaluateScopeActivationRules(request.input, request.options);
        break;
      case "conflicts-duplication":
        result = evaluateConflictsDuplicationRules(request.input, request.options);
        break;
      case "repository-drift":
        result = evaluateRepositoryDrift(
          request.input.statements,
          request.input.evidenceIndex,
          request.options,
        );
        break;
      case "document-context":
        result = evaluateDocumentContextRules(request.input, request.options);
        break;
      case "security":
        result = evaluateSecurityRules(request.input, request.options);
        break;
      case "portability":
        result = evaluatePortabilityRules(request.input, request.options);
        break;
      case "standards-freshness":
        result = evaluateStandardsFreshnessRules(request.input);
        break;
      case "context-efficiency":
        result = evaluateContextEfficiencyRules(request.input, request.options);
        break;
    }
    if (failedResult(result))
      return schedulerIssue(
        "family-failure",
        `$.families.${request.familyId}`,
        "the built-in evaluator rejected its validated request",
        request.familyId,
      );
    const bundle = resultBundle(result);
    if (bundle === undefined)
      return schedulerIssue(
        "family-failure",
        `$.families.${request.familyId}`,
        "the built-in evaluator returned no diagnostic bundle",
        request.familyId,
      );
    return Object.freeze({
      bundle,
      diagnosticCount: bundle.diagnostics.length,
      familyId: request.familyId,
      sources: resultSources(result),
      syntaxEvaluation:
        request.familyId === "syntax-structure" ? (result as SyntaxStructureRuleResult) : null,
    });
  } catch {
    return schedulerIssue(
      "family-failure",
      `$.families.${request.familyId}`,
      "the built-in evaluator rejected its validated request",
      request.familyId,
    );
  }
}

function perturbationTurns(familyId: RuleFamilyId, seed: number): number {
  if (seed === 0) return 0;
  let state = seed >>> 0;
  for (const byte of Buffer.from(familyId, "utf8"))
    state = (Math.imul(state ^ byte, 1_664_525) + 1_013_904_223) >>> 0;
  return (state % 3) + 1;
}

async function perturbCompletion(
  familyId: RuleFamilyId,
  seed: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  for (let turn = 0; turn < perturbationTurns(familyId, seed); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (signal !== undefined && abortState(signal) !== false) return false;
  }
  return true;
}

async function runLevel(
  level: readonly RuleFamilyId[],
  prepared: ReadonlyMap<RuleFamilyId, FamilyExecution>,
  options: NormalizedOptions,
  startedAt: number,
): Promise<readonly (FamilyExecution | RuleSchedulerIssue)[]> {
  const results: (FamilyExecution | RuleSchedulerIssue)[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(level.length, options.limits.maximumConcurrency) },
    async (): Promise<void> => {
      while (cursor < level.length) {
        const index = cursor;
        cursor += 1;
        const familyId = level[index];
        if (familyId === undefined) return;
        if (options.signal !== undefined && abortState(options.signal) !== false) return;
        if (performance.now() - startedAt > options.limits.maximumDurationMs) return;
        if (!(await perturbCompletion(familyId, options.limits.scheduleSeed, options.signal)))
          return;
        const execution = prepared.get(familyId);
        if (execution === undefined) {
          results.push(
            schedulerIssue(
              "dependency-failure",
              "$.families",
              "a prepared family result is missing",
              familyId,
            ),
          );
          continue;
        }
        results.push(execution);
      }
    },
  );
  await Promise.all(workers);
  return Object.freeze(results);
}

function sameSourceRegistries(
  left: readonly SourceDocument[],
  right: readonly SourceDocument[],
): boolean {
  if (left.length !== right.length || left.length > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSources)
    return false;
  for (let index = 0; index < left.length; index += 1) {
    const first = left[index];
    const second = right[index];
    if (first === undefined || second === undefined) return false;
    if (
      first.bom !== second.bom ||
      first.byteLength !== second.byteLength ||
      !Object.is(first.encoding, second.encoding) ||
      first.id !== second.id ||
      first.lineEnding !== second.lineEnding ||
      first.path !== second.path ||
      first.rootNodeId !== second.rootNodeId ||
      first.sha256 !== second.sha256 ||
      first.text !== second.text ||
      first.utf16Length !== second.utf16Length ||
      canonicalJson(first.parseState) !== canonicalJson(second.parseState)
    )
      return false;
  }
  return true;
}

function schedulingCheckpoint(
  options: NormalizedOptions,
  startedAt: number,
): RuleSchedulerIssue | undefined {
  if (options.signal !== undefined && abortState(options.signal) !== false)
    return schedulerIssue("cancelled", "$options.signal", "scheduling was cancelled");
  if (performance.now() - startedAt > options.limits.maximumDurationMs)
    return schedulerIssue(
      "deadline-exceeded",
      "$options.maximumDurationMs",
      "scheduling exceeded its deadline",
    );
  return undefined;
}

function belongsToFamily(familyId: RuleFamilyId, diagnostic: Diagnostic): boolean {
  return FAMILY_BY_ID.get(familyId)?.ruleIds.includes(diagnostic.ruleId) === true;
}

function summaryOf(
  bundle: DiagnosticBundle,
  threshold: RuleSchedulerFailureThreshold,
): {
  readonly summary: RuleSchedulerSummary;
  readonly suppressed: readonly Diagnostic[];
  readonly visible: readonly Diagnostic[];
} {
  const suppressedFingerprints = new Set(
    bundle.suppressions
      .filter((entry) => entry.state === "suppressed")
      .flatMap((entry) => entry.matchedPathFingerprints),
  );
  const suppressed = Object.freeze(
    bundle.diagnostics.filter((entry) => suppressedFingerprints.has(entry.fingerprints.path.value)),
  );
  const visible = Object.freeze(
    bundle.diagnostics.filter(
      (entry) => !suppressedFingerprints.has(entry.fingerprints.path.value),
    ),
  );
  const active = { error: 0, info: 0, warning: 0 };
  for (const diagnostic of visible) active[diagnostic.severity] += 1;
  const shouldFail =
    threshold === "warning"
      ? active.error + active.warning > 0
      : threshold === "error"
        ? active.error > 0
        : false;
  return Object.freeze({
    summary: Object.freeze({
      active: Object.freeze(active),
      diagnosticCount: bundle.diagnostics.length,
      failureThreshold: threshold,
      shouldFail,
      suppressedCount: suppressedFingerprints.size,
    }),
    suppressed,
    visible,
  });
}

/** Compose the ten built-in F05-F14 evaluators into deterministic immutable B04 output. */
export async function scheduleRuleFamilies(
  rawInput: unknown,
  rawOptions?: unknown,
): Promise<RuleSchedulerResult> {
  const startedAt = performance.now();
  const options = normalizeOptions(rawOptions);
  if (isIssue(options)) return schedulerFailure(options);
  const preSnapshotCheckpoint = schedulingCheckpoint(options, startedAt);
  if (preSnapshotCheckpoint !== undefined) return schedulerFailure(preSnapshotCheckpoint);
  // Normalization creates the bounded engine-owned B03 snapshot synchronously. Once this
  // returns, later caller mutation cannot change the scheduled evaluation.
  const input = normalizeInput(rawInput);
  if (isIssue(input)) return schedulerFailure(input);
  const initialCheckpoint = schedulingCheckpoint(options, startedAt);
  if (initialCheckpoint !== undefined) return schedulerFailure(initialCheckpoint);
  const levels = topologicalLevels(input.requests);
  // normalizeInput requires F05 and RULE_FAMILY_DESCRIPTORS is module-owned and acyclic.
  // Every current built-in family is synchronous and bounded. Evaluate and validate all
  // caller-bearing requests before the first await, retaining only immutable family results.
  // Concurrency and seeded perturbation below therefore schedule completed outputs and cannot
  // expose a mutation race without weakening same-process evidence identity.
  const prepared = new Map<RuleFamilyId, FamilyExecution>();
  let admittedDiagnosticCount = 0;
  for (const level of levels) {
    for (const familyId of level) {
      const checkpoint = schedulingCheckpoint(options, startedAt);
      if (checkpoint !== undefined) return schedulerFailure(checkpoint);
      const request = input.requests.get(familyId);
      if (request === undefined)
        return schedulerFailure(
          schedulerIssue(
            "dependency-failure",
            "$.families",
            "a family request is missing",
            familyId,
          ),
        );
      const execution = runFamily(request);
      if (isIssue(execution)) return schedulerFailure(execution);
      if (familyId === "syntax-structure" && !execution.syntaxEvaluation?.ok)
        return schedulerFailure(
          schedulerIssue(
            "dependency-failure",
            "$.families.syntax-structure",
            "the F05 authority result is missing or invalid",
            familyId,
          ),
        );
      if (
        execution.sources !== null &&
        !sameSourceRegistries(execution.sources, input.snapshotIr.sources)
      )
        return schedulerFailure(
          schedulerIssue(
            "invalid-output",
            "$output.sources",
            "family source registry differs from the engine snapshot",
            familyId,
          ),
        );
      if (!validateDiagnosticBundle(execution.bundle, input.snapshotIr.sources).ok)
        return schedulerFailure(
          schedulerIssue(
            "invalid-output",
            "$output.diagnostics",
            "family diagnostics are not bound to the engine snapshot",
            familyId,
          ),
        );
      if (execution.bundle.diagnostics.some((diagnostic) => !belongsToFamily(familyId, diagnostic)))
        return schedulerFailure(
          schedulerIssue(
            "invalid-output",
            "$output.diagnostics",
            "family emitted an unowned rule",
            familyId,
          ),
        );
      admittedDiagnosticCount += execution.bundle.diagnostics.length;
      if (admittedDiagnosticCount > options.limits.maximumDiagnostics)
        return schedulerFailure(
          schedulerIssue(
            "resource-limit",
            "$output.diagnostics",
            "diagnostics exceed the scheduler limit",
          ),
        );
      prepared.set(familyId, execution);
    }
  }
  const executions = new Map<RuleFamilyId, FamilyExecution>();
  for (const level of levels) {
    const completed = await runLevel(level, prepared, options, startedAt);
    const checkpoint = schedulingCheckpoint(options, startedAt);
    if (checkpoint !== undefined) return schedulerFailure(checkpoint);
    const failure = completed
      .filter(isIssue)
      .sort((left, right) => compareUtf8(left.familyId ?? "", right.familyId ?? ""))[0];
    if (failure !== undefined) return schedulerFailure(failure);
    for (const entry of completed) if (!isIssue(entry)) executions.set(entry.familyId, entry);
  }
  // normalizeInput requires F05 and synchronous admission above retained its validated result.
  const syntax = prepared.get("syntax-structure") as FamilyExecution & {
    readonly syntaxEvaluation: SyntaxStructureRuleResult & { readonly ok: true };
  };
  const sources = input.snapshotIr.sources;
  const diagnostics: Diagnostic[] = [];
  for (const execution of [...executions.values()].sort((left, right) =>
    compareUtf8(left.familyId, right.familyId),
  )) {
    const checkpoint = schedulingCheckpoint(options, startedAt);
    if (checkpoint !== undefined) return schedulerFailure(checkpoint);
    diagnostics.push(...execution.bundle.diagnostics);
  }
  const rawBundle: DiagnosticBundle = Object.freeze({
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics: Object.freeze(diagnostics),
    recordKind: "agent-context-diagnostics",
    suppressions: syntax.bundle.suppressions,
  });
  const filtered = policyFilteredBundle(rawBundle, sources, input.policy);
  if (!filtered.ok) return filtered;
  const finalized = finalizeScheduledSyntaxSuppressions(
    syntax.syntaxEvaluation,
    filtered.bundle.diagnostics,
  );
  if (!finalized.ok)
    return schedulerFailure(
      schedulerIssue(
        finalized.issues.some((entry) => entry.code === "resource-limit")
          ? "resource-limit"
          : "dependency-failure",
        "$output.suppressions",
        "B08 finalization failed",
      ),
    );
  if (finalized.bundle.diagnostics.length > options.limits.maximumDiagnostics)
    return schedulerFailure(
      schedulerIssue(
        "resource-limit",
        "$output.diagnostics",
        "diagnostics exceed the scheduler limit after ACL109 finalization",
      ),
    );
  const canonical = canonicalizeRuleDiagnostics(finalized.bundle, sources, input.policy);
  if (!canonical.ok) return canonical;
  // Exact-pair deduplication cannot increase the post-ACL109 count checked above.
  const checkpoint = schedulingCheckpoint(options, startedAt);
  if (checkpoint !== undefined) return schedulerFailure(checkpoint);
  const views = summaryOf(canonical.bundle, input.policy.failureThreshold);
  const result: RuleSchedulerSuccess = {
    bundle: canonical.bundle,
    contractVersion: RULE_SCHEDULER_CONTRACT_VERSION,
    executionOrder: Object.freeze(levels.flatMap((level) => level)),
    families: Object.freeze(
      [...executions.values()]
        .sort((left, right) => compareUtf8(left.familyId, right.familyId))
        .map((entry) =>
          Object.freeze({
            diagnosticCount: entry.diagnosticCount,
            familyId: entry.familyId,
            ticketId: FAMILY_BY_ID.get(entry.familyId)?.ticketId ?? "F15",
          }),
        ),
    ),
    limits: options.limits,
    ok: true,
    recordKind: "agent-context-rule-scheduler-result",
    sources: Object.freeze([...sources]),
    summary: views.summary,
    suppressedDiagnostics: views.suppressed,
    visibleDiagnostics: views.visible,
  };
  const issued = deepFreezeData(result);
  ISSUED_RULE_SCHEDULER_SUCCESSES.add(issued);
  return issued;
}
