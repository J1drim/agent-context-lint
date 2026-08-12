import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import {
  matchSuppressionDirectives,
  parseFrontmatter,
  parseSuppressionDirectives,
} from "@agent-context/syntax";
import { issueSafeFixEligibility } from "@agent-context/evidence";

import type {
  ClientProfileId,
  AtomicFixPlan,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSourceLocation,
  FingerprintComponent,
  FixPlanId,
  InstructionIr,
  RelatedEvidence,
  RelatedEvidenceId,
  SourceDocument,
  SourceRange,
  SpecRelatedEvidence,
} from "@agent-context/core";
import type { SafeFixEligibility } from "@agent-context/evidence";
import type {
  FrontmatterDialect,
  FrontmatterLocation,
  FrontmatterParseResult,
  ParsedSuppressionDirective,
  SuppressionDirectiveIssue,
} from "@agent-context/syntax";

import { findRuleMetadata } from "./registry.js";

export const SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const SYNTAX_STRUCTURE_RULE_VERSION = "1.0.0" as const;
export const SYNTAX_STRUCTURE_RULE_IDS = [
  "ACL100",
  "ACL101",
  "ACL102",
  "ACL103",
  "ACL104",
  "ACL105",
  "ACL106",
  "ACL107",
  "ACL108",
  "ACL109",
] as const;

export type SyntaxStructureRuleId = (typeof SYNTAX_STRUCTURE_RULE_IDS)[number];
export type FrontmatterValueType = "boolean" | "number" | "string" | "string-array";

export interface FrontmatterFieldPolicy {
  readonly globSyntax: "none" | "path-glob-v1";
  readonly name: string;
  readonly types: readonly FrontmatterValueType[];
}

export interface SyntaxSpecEvidence {
  readonly evidenceRefId: string;
  readonly retrievedAt: string;
  readonly revision: string | null;
  readonly url: string;
}

export interface SyntaxProfileObservation {
  readonly evidence: SyntaxSpecEvidence;
  readonly profileId: string;
  readonly specSnapshotId: string;
  readonly state: "current" | "deprecated" | "supported" | "unknown" | "unsupported";
  readonly surfaceId: string;
}

export interface SyntaxDocumentPolicy {
  readonly dialect: FrontmatterDialect | null;
  readonly fields: readonly FrontmatterFieldPolicy[];
  readonly format: readonly SyntaxProfileObservation[];
  readonly location: readonly SyntaxProfileObservation[];
  readonly sourceId: string;
  readonly vendorId: string;
}

export interface SyntaxStructureRuleInput {
  readonly contractVersion: typeof SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION;
  readonly documents: readonly SyntaxDocumentPolicy[];
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-syntax-structure-rule-input";
}

export interface SyntaxStructureRuleIssue {
  readonly code: "dependency-failure" | "invalid-input" | "resource-limit";
  readonly message: string;
  readonly path: string;
}

export interface SyntaxStructureRuleMetrics {
  readonly diagnosticCount: number;
  readonly documentCount: number;
  readonly suppressionDirectiveCount: number;
  readonly suppressionIssueCount: number;
}

export type SyntaxStructureRuleResult =
  | {
      readonly ok: true;
      readonly bundle: DiagnosticBundle;
      readonly metrics: SyntaxStructureRuleMetrics;
      readonly sources: readonly SourceDocument[];
    }
  | { readonly ok: false; readonly issues: readonly SyntaxStructureRuleIssue[] };

export type SyntaxSuppressionFinalizationResult =
  | {
      readonly ok: true;
      readonly bundle: DiagnosticBundle;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly issues: readonly SyntaxStructureRuleIssue[] };

export type SyntaxSuppressionFinalizationIssuance = "complete" | "scheduled-reporting";

export interface ApprovedMechanicalFixPlanResult {
  readonly bundle: DiagnosticBundle;
  /** Unforgeable I11 authorities, ordered by their corresponding plan IDs. */
  readonly candidates: readonly SafeFixEligibility[];
  readonly contractVersion: typeof SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION;
  readonly eligiblePlanIds: readonly string[];
  readonly ok: true;
  readonly sources: readonly SourceDocument[];
}

export type ApprovedMechanicalFixResult =
  | ApprovedMechanicalFixPlanResult
  | { readonly ok: false; readonly issues: readonly SyntaxStructureRuleIssue[] };

interface ValidatedPolicy {
  readonly dialect: FrontmatterDialect | null;
  readonly fields: readonly FrontmatterFieldPolicy[];
  readonly format: readonly SyntaxProfileObservation[];
  readonly location: readonly SyntaxProfileObservation[];
  readonly sourceId: string;
  readonly vendorId: string;
}

interface IssuedEvaluation {
  readonly directives: readonly ParsedSuppressionDirective[];
  readonly ir: InstructionIr;
}

interface IssuedMechanicalDiagnostic {
  readonly diagnostic: Diagnostic;
  readonly directive: ParsedSuppressionDirective;
}

interface IssuedFinalization {
  readonly eligible: readonly IssuedMechanicalDiagnostic[];
  readonly ir: InstructionIr;
  readonly issuance: SyntaxSuppressionFinalizationIssuance;
}

const issuedEvaluations = new WeakMap<object, IssuedEvaluation>();
const issuedFinalizations = new WeakMap<object, IssuedFinalization>();
const INPUT_KEYS = new Set(["contractVersion", "documents", "ir", "recordKind"]);
const POLICY_KEYS = new Set(["dialect", "fields", "format", "location", "sourceId", "vendorId"]);
const FIELD_KEYS = new Set(["globSyntax", "name", "types"]);
const OBSERVATION_KEYS = new Set(["evidence", "profileId", "specSnapshotId", "state", "surfaceId"]);
const EVIDENCE_KEYS = new Set(["evidenceRefId", "retrievedAt", "revision", "url"]);
const VALUE_TYPES = new Set<FrontmatterValueType>(["boolean", "number", "string", "string-array"]);
const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_POLICIES = 1_024;
const MAX_FIELDS = 128;
const MAX_OBSERVATIONS = 128;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function issue(
  code: SyntaxStructureRuleIssue["code"],
  path: string,
  message: string,
): SyntaxStructureRuleIssue {
  return Object.freeze({ code, message, path });
}

function failure(value: SyntaxStructureRuleIssue): SyntaxStructureRuleResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function finalizationFailure(value: SyntaxStructureRuleIssue): SyntaxSuppressionFinalizationResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function approvedMechanicalFailure(value: SyntaxStructureRuleIssue): ApprovedMechanicalFixResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function record(
  value: unknown,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return undefined;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (
      (Reflect.getPrototypeOf(value) !== Object.prototype &&
        Reflect.getPrototypeOf(value) !== null) ||
      ownKeys.length !== keys.size ||
      ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of ownKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.set(key as string, descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function array(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function stable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    STABLE_ID.test(value)
  );
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function observation(value: unknown): SyntaxProfileObservation | undefined {
  const input = record(value, OBSERVATION_KEYS);
  if (input === undefined) return undefined;
  const evidenceInput = record(input.get("evidence"), EVIDENCE_KEYS);
  const state = input.get("state");
  const revision = evidenceInput?.get("revision");
  const url = evidenceInput?.get("url");
  if (
    evidenceInput === undefined ||
    !stable(input.get("profileId")) ||
    !stable(input.get("surfaceId")) ||
    !stable(input.get("specSnapshotId")) ||
    !["current", "deprecated", "supported", "unknown", "unsupported"].includes(String(state)) ||
    !stable(evidenceInput.get("evidenceRefId")) ||
    !isoDate(evidenceInput.get("retrievedAt")) ||
    (revision !== null && typeof revision !== "string") ||
    typeof url !== "string" ||
    url.length === 0 ||
    url.length > 4_096
  )
    return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return Object.freeze({
    evidence: Object.freeze({
      evidenceRefId: evidenceInput.get("evidenceRefId") as string,
      retrievedAt: evidenceInput.get("retrievedAt") as string,
      revision,
      url,
    }),
    profileId: input.get("profileId") as string,
    specSnapshotId: input.get("specSnapshotId") as string,
    state: state as SyntaxProfileObservation["state"],
    surfaceId: input.get("surfaceId") as string,
  });
}

function observations(value: unknown): readonly SyntaxProfileObservation[] | undefined {
  const input = array(value, MAX_OBSERVATIONS);
  if (input === undefined) return undefined;
  const output: SyntaxProfileObservation[] = [];
  const identities = new Set<string>();
  for (const entry of input) {
    const parsed = observation(entry);
    if (parsed === undefined) return undefined;
    const identity = `${parsed.profileId}\0${parsed.surfaceId}\0${parsed.specSnapshotId}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    output.push(parsed);
  }
  return Object.freeze(
    output.sort((left, right) =>
      compareUtf8(
        `${left.profileId}\0${left.surfaceId}\0${left.specSnapshotId}`,
        `${right.profileId}\0${right.surfaceId}\0${right.specSnapshotId}`,
      ),
    ),
  );
}

function fields(value: unknown): readonly FrontmatterFieldPolicy[] | undefined {
  const input = array(value, MAX_FIELDS);
  if (input === undefined) return undefined;
  const output: FrontmatterFieldPolicy[] = [];
  const names = new Set<string>();
  for (const entry of input) {
    const item = record(entry, FIELD_KEYS);
    const types = array(item?.get("types"), VALUE_TYPES.size);
    const name = item?.get("name");
    const globSyntax = item?.get("globSyntax");
    if (
      item === undefined ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) ||
      names.has(name) ||
      (globSyntax !== "none" && globSyntax !== "path-glob-v1") ||
      types === undefined ||
      types.length === 0 ||
      types.some(
        (type) => typeof type !== "string" || !VALUE_TYPES.has(type as FrontmatterValueType),
      ) ||
      new Set(types).size !== types.length ||
      (globSyntax === "path-glob-v1" &&
        !types.includes("string") &&
        !types.includes("string-array"))
    )
      return undefined;
    names.add(name);
    output.push(
      Object.freeze({
        globSyntax,
        name,
        types: Object.freeze([...(types as readonly FrontmatterValueType[])].sort(compareUtf8)),
      }),
    );
  }
  return Object.freeze(output.sort((left, right) => compareUtf8(left.name, right.name)));
}

function policies(value: unknown): readonly ValidatedPolicy[] | undefined {
  const input = array(value, MAX_POLICIES);
  if (input === undefined) return undefined;
  const output: ValidatedPolicy[] = [];
  const sources = new Set<string>();
  for (const entry of input) {
    const item = record(entry, POLICY_KEYS);
    if (item === undefined) return undefined;
    const sourceId = item.get("sourceId");
    const vendorId = item.get("vendorId");
    const dialect = item.get("dialect");
    const parsedFields = fields(item.get("fields"));
    const format = observations(item.get("format"));
    const location = observations(item.get("location"));
    if (
      !stable(sourceId) ||
      !stable(vendorId) ||
      sources.has(sourceId) ||
      (dialect !== null && dialect !== "yaml" && dialect !== "mdc") ||
      parsedFields === undefined ||
      format === undefined ||
      location === undefined
    )
      return undefined;
    sources.add(sourceId);
    output.push(
      Object.freeze({ dialect, fields: parsedFields, format, location, sourceId, vendorId }),
    );
  }
  return Object.freeze(output.sort((left, right) => compareUtf8(left.sourceId, right.sourceId)));
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function location(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareUtf8(left.primary.path, right.primary.path) ||
    left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
    compareUtf8(left.ruleId, right.ruleId) ||
    compareUtf8(left.id, right.id)
  );
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  input: {
    readonly anchor: string;
    readonly components: readonly FingerprintComponent[];
    readonly message: string;
    readonly primary: DiagnosticSourceLocation;
    readonly profiles?: readonly string[];
    readonly related?: readonly RelatedEvidence[];
    readonly ruleId: SyntaxStructureRuleId;
    readonly suggestion: string;
  },
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS_PER_BUNDLE) throw new RangeError("diagnostic limit");
  const profileIds: readonly ClientProfileId[] = Object.freeze(
    [...(input.profiles ?? [])].sort(compareUtf8),
  );
  const pathBasis = Object.freeze({ anchor: input.anchor, profileIds });
  const semanticBasis = Object.freeze({
    components: Object.freeze([...input.components].sort((a, b) => compareUtf8(a.key, b.key))),
    profileIds,
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId: input.ruleId,
    ruleVersion: SYNTAX_STRUCTURE_RULE_VERSION,
  });
  const pathFingerprint = computePathFingerprint({
    basis: pathBasis,
    path: input.primary.path,
    ruleId: input.ruleId,
    ruleVersion: SYNTAX_STRUCTURE_RULE_VERSION,
  });
  const diagnosticIdentity = sha256(semantic, pathFingerprint);
  const metadata = findRuleMetadata(input.ruleId);
  if (metadata === undefined) throw new TypeError("syntax rule is absent from the B09 registry");
  diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({
          method: PATH_FINGERPRINT_METHOD,
          value: pathFingerprint,
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${input.ruleId.toLowerCase()}:${diagnosticIdentity.slice(0, 32)}` as DiagnosticId,
      message: input.message,
      primary: input.primary,
      related: Object.freeze([...(input.related ?? [])]),
      ruleId: input.ruleId,
      ruleVersion: SYNTAX_STRUCTURE_RULE_VERSION,
      severity: metadata.defaultSeverity,
      suggestion: Object.freeze({ fixPlan: null, message: input.suggestion }),
    }),
  );
}

function sourceRange(source: SourceDocument, ir: InstructionIr): SourceRange {
  const root = ir.nodes.find((node) => node.id === source.rootNodeId);
  if (root === undefined) throw new TypeError("validated source root is missing");
  return root.range;
}

function rangeForField(parsed: FrontmatterParseResult, field: string): SourceRange | null {
  const found: FrontmatterLocation | undefined = parsed.locations.find(
    (entry) => entry.path === `$/${field}`,
  );
  return found?.valueRange ?? found?.keyRange ?? parsed.frontmatterRange;
}

function actualType(value: unknown): FrontmatterValueType | "other" {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "string-array";
  return "other";
}

function distance(left: string, right: string): number {
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (prior[rightIndex + 1] ?? 0) + 1,
          (prior[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    prior = current;
  }
  return prior[right.length] ?? Math.max(left.length, right.length);
}

function suggestion(field: string, allowed: readonly string[]): string | null {
  const candidates = allowed
    .map((name) => ({ distance: distance(field.toLowerCase(), name.toLowerCase()), name }))
    .sort((a, b) => a.distance - b.distance || compareUtf8(a.name, b.name));
  const first = candidates[0];
  const second = candidates[1];
  const maximum = Math.max(1, Math.floor(field.length / 3));
  return first !== undefined && first.distance <= maximum && first.distance !== second?.distance
    ? first.name
    : null;
}

function invalidGlob(pattern: string): string | null {
  if (pattern.length === 0) return "pattern is empty";
  if (Buffer.byteLength(pattern, "utf8") > 4_096) return "pattern exceeds 4096 UTF-8 bytes";
  if (/^[/.]|\/$|\/\/|\\|(?:^|\/)\.\.(?:\/|$)/u.test(pattern))
    return "pattern is not a canonical repository-relative glob";
  for (const scalar of pattern) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      return "pattern contains a control character";
  }
  let bracket = false;
  let brace = false;
  let braceContent = "";
  for (const scalar of pattern) {
    if (scalar === "[") {
      if (bracket) return "pattern contains nested bracket expressions";
      bracket = true;
    } else if (scalar === "]") {
      if (!bracket) return "pattern contains an unmatched closing bracket";
      bracket = false;
    } else if (scalar === "{") {
      if (brace) return "pattern contains nested brace expressions";
      brace = true;
      braceContent = "";
    } else if (scalar === "}") {
      if (!brace) return "pattern contains an unmatched closing brace";
      if (!braceContent.includes(",") || braceContent.split(",").some((part) => part.length === 0))
        return "brace expansion must contain non-empty alternatives";
      brace = false;
    } else if (brace) braceContent += scalar;
  }
  if (bracket) return "pattern contains an unclosed bracket expression";
  if (brace) return "pattern contains an unclosed brace expression";
  if (pattern.split("/").some((segment) => segment.includes("**") && segment !== "**"))
    return "globstar must occupy a complete path segment";
  return null;
}

function specEvidence(observation: SyntaxProfileObservation, seed: string): SpecRelatedEvidence {
  return Object.freeze({
    evidenceRefId: observation.evidence.evidenceRefId,
    factId: null,
    id: `evidence:${sha256(seed, observation.profileId, observation.surfaceId).slice(0, 32)}` as RelatedEvidenceId,
    kind: "spec",
    label: "Profile syntax support evidence",
    retrievedAt: observation.evidence.retrievedAt,
    revision: observation.evidence.revision,
    specSnapshotId: observation.specSnapshotId,
    url: observation.evidence.url,
  });
}

function evaluateFrontmatter(
  diagnostics: Diagnostic[],
  source: SourceDocument,
  policy: ValidatedPolicy,
  ir: InstructionIr,
): FrontmatterParseResult | null {
  const root = sourceRange(source, ir);
  if (policy.dialect === null) {
    if (source.text.trim().length === 0)
      addDiagnostic(diagnostics, {
        anchor: `document:${source.id}`,
        components: [{ key: "content", value: source.sha256 }],
        message: "Instruction document is empty.",
        primary: location(source, root),
        ruleId: "ACL104",
        suggestion: "Remove the document or add explicit instructions.",
      });
    return null;
  }
  const parsed = parseFrontmatter({
    bytes: new Uint8Array(Buffer.from(source.text, "utf8")),
    dialect: policy.dialect,
    sourceId: source.id,
  });
  for (const parseIssue of parsed.issues) {
    const ruleId = parseIssue.code === "duplicate-key" ? "ACL107" : "ACL100";
    addDiagnostic(diagnostics, {
      anchor: `frontmatter:${source.id}:${String(parseIssue.range?.start.byteOffset ?? 0)}`,
      components: [
        { key: "dialect", value: policy.dialect },
        { key: "issue", value: parseIssue.code },
      ],
      message:
        ruleId === "ACL107"
          ? "Frontmatter contains a duplicate key."
          : `Invalid ${policy.dialect.toUpperCase()} frontmatter (${parseIssue.code}).`,
      primary: location(source, parseIssue.range ?? parsed.frontmatterRange ?? root),
      ruleId,
      suggestion:
        ruleId === "ACL107"
          ? "Keep exactly one value for each frontmatter key."
          : "Correct the frontmatter before relying on its activation metadata.",
    });
  }
  if (parsed.value !== null) {
    const policyByName = new Map(policy.fields.map((field) => [field.name, field]));
    for (const name of Object.keys(parsed.value).sort(compareUtf8)) {
      const value = parsed.value[name];
      const field = policyByName.get(name);
      const primary = location(source, rangeForField(parsed, name) ?? root);
      if (field === undefined) {
        const suggested = suggestion(
          name,
          policy.fields.map((entry) => entry.name),
        );
        addDiagnostic(diagnostics, {
          anchor: `frontmatter-field:${source.id}:${name}`,
          components: [
            { key: "field", value: name },
            { key: "vendor", value: policy.vendorId },
          ],
          message: `Unknown ${policy.vendorId} frontmatter field '${name}'${suggested === null ? "." : `; did you mean '${suggested}'?`}`,
          primary,
          ruleId: "ACL102",
          suggestion:
            suggested === null
              ? `Remove '${name}' or confirm it in the ${policy.vendorId} specification.`
              : `Rename '${name}' to '${suggested}' after reviewing the vendor specification.`,
        });
        continue;
      }
      const type = actualType(value);
      if (!field.types.includes(type as FrontmatterValueType)) {
        addDiagnostic(diagnostics, {
          anchor: `frontmatter-field:${source.id}:${name}`,
          components: [
            { key: "actual-type", value: type },
            { key: "field", value: name },
            { key: "vendor", value: policy.vendorId },
          ],
          message: `Frontmatter field '${name}' has type ${type}; expected ${field.types.join(" or ")}.`,
          primary,
          ruleId: "ACL101",
          suggestion: `Use a ${field.types.join(" or ")} value documented by ${policy.vendorId}.`,
        });
        continue;
      }
      if (field.globSyntax === "path-glob-v1") {
        const patterns = typeof value === "string" ? [value] : (value as readonly string[]);
        for (const [index, pattern] of patterns.entries()) {
          const reason = invalidGlob(pattern);
          if (reason === null) continue;
          addDiagnostic(diagnostics, {
            anchor: `frontmatter-glob:${source.id}:${name}:${String(index)}`,
            components: [
              { key: "field", value: name },
              { key: "pattern-index", value: String(index) },
              { key: "reason", value: reason },
              { key: "vendor", value: policy.vendorId },
            ],
            message: `Frontmatter glob in '${name}' is invalid: ${reason}.`,
            primary,
            ruleId: "ACL103",
            suggestion: "Use a bounded repository-relative glob with balanced delimiters.",
          });
        }
      }
    }
  }
  const body = parsed.bodyRange;
  if (parsed.text !== null && body !== null) {
    const bodyText = source.text.slice(body.start.utf16Offset, body.end.utf16Offset);
    if (bodyText.trim().length === 0)
      addDiagnostic(diagnostics, {
        anchor: `document:${source.id}`,
        components: [{ key: "content", value: source.sha256 }],
        message: "Instruction document has no body content.",
        primary: location(source, body),
        ruleId: "ACL104",
        suggestion: "Remove the document or add explicit instructions.",
      });
  }
  return parsed;
}

function evaluateObservations(
  diagnostics: Diagnostic[],
  source: SourceDocument,
  observations: readonly SyntaxProfileObservation[],
  kind: "format" | "location",
  ir: InstructionIr,
): void {
  for (const entry of observations) {
    const emit = kind === "location" ? entry.state === "unsupported" : entry.state === "deprecated";
    if (!emit) continue;
    const ruleId = kind === "location" ? "ACL105" : "ACL106";
    const identity = `${entry.profileId}:${entry.surfaceId}:${entry.specSnapshotId}`;
    addDiagnostic(diagnostics, {
      anchor: `${kind}:${source.id}:${identity}`,
      components: [
        { key: "profile", value: entry.profileId },
        { key: "snapshot", value: entry.specSnapshotId },
        { key: "surface", value: entry.surfaceId },
      ],
      message:
        kind === "location"
          ? `Instruction location is unsupported by ${entry.profileId}/${entry.surfaceId}.`
          : `Instruction format is deprecated for ${entry.profileId}/${entry.surfaceId}.`,
      primary: location(source, sourceRange(source, ir)),
      profiles: [entry.profileId],
      related: [specEvidence(entry, `${source.id}:${kind}`)],
      ruleId,
      suggestion:
        kind === "location"
          ? "Move the instruction to a location documented for the selected surface."
          : "Migrate to the current instruction format documented for the selected surface.",
    });
  }
}

function evaluateSuppressionIssues(
  diagnostics: Diagnostic[],
  values: readonly SuppressionDirectiveIssue[],
): void {
  for (const value of values) {
    addDiagnostic(diagnostics, {
      anchor: `suppression:${value.location.sourceId}:${String(value.location.range.start.byteOffset)}`,
      components: [{ key: "issue", value: value.code }],
      message: `Invalid suppression directive (${value.code}).`,
      primary: value.location,
      ruleId: "ACL108",
      suggestion: "Use a closed disable-next-line directive naming explicit ACL rule IDs.",
    });
  }
}

export function evaluateSyntaxStructureRules(rawInput: unknown): SyntaxStructureRuleResult {
  const input = record(rawInput, INPUT_KEYS);
  if (
    input?.get("recordKind") !== "agent-context-syntax-structure-rule-input" ||
    input.get("contractVersion") !== SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION
  )
    return failure(issue("invalid-input", "$", "input kind or contract version is invalid"));
  const parsedPolicies = policies(input.get("documents"));
  if (parsedPolicies === undefined)
    return failure(issue("invalid-input", "$.documents", "must be a closed bounded policy array"));
  const validated = validateInstructionIr(input.get("ir"));
  if (!validated.ok)
    return failure(issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
  const ir = validated.value;
  const sourceById: ReadonlyMap<string, SourceDocument> = new Map(
    ir.sources.map((source) => [source.id, source]),
  );
  if (parsedPolicies.some((policy) => !sourceById.has(policy.sourceId)))
    return failure(issue("invalid-input", "$.documents", "references an unknown B03 source"));
  try {
    const diagnostics: Diagnostic[] = [];
    for (const policy of parsedPolicies) {
      const source = sourceById.get(policy.sourceId);
      if (source === undefined) throw new TypeError("validated policy source is missing");
      evaluateFrontmatter(diagnostics, source, policy, ir);
      evaluateObservations(diagnostics, source, policy.location, "location", ir);
      evaluateObservations(diagnostics, source, policy.format, "format", ir);
    }
    const suppression = parseSuppressionDirectives(ir);
    evaluateSuppressionIssues(diagnostics, suppression.issues);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const bundleValidation = validateDiagnosticBundle(bundle, ir.sources);
    if (!bundleValidation.ok)
      return failure(
        issue("dependency-failure", "$output", "generated output failed B04 validation"),
      );
    const result = Object.freeze({
      bundle: bundleValidation.value,
      metrics: Object.freeze({
        diagnosticCount: diagnostics.length,
        documentCount: parsedPolicies.length,
        suppressionDirectiveCount: suppression.directives.length,
        suppressionIssueCount: suppression.issues.length,
      }),
      ok: true as const,
      sources: Object.freeze([...ir.sources]),
    });
    issuedEvaluations.set(result, { directives: suppression.directives, ir });
    return result;
  } catch (error) {
    return failure(
      issue(
        error instanceof RangeError ? "resource-limit" : "dependency-failure",
        "$",
        error instanceof RangeError
          ? "a bounded evaluation resource limit was exceeded"
          : "a deterministic dependency rejected the validated input",
      ),
    );
  }
}

export function finalizeSyntaxSuppressions(
  evaluation: unknown,
  additionalDiagnostics: unknown = [],
): SyntaxSuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const extra = array(additionalDiagnostics, MAX_DIAGNOSTICS_PER_BUNDLE);
  if (extra === undefined)
    return finalizationFailure(
      issue("invalid-input", "$.additionalDiagnostics", "must be a bounded dense array"),
    );
  const result = evaluation as Extract<SyntaxStructureRuleResult, { readonly ok: true }>;
  return finalizeIssuedSyntaxSuppressions(
    evaluation,
    Object.freeze([...result.bundle.diagnostics, ...(extra as readonly Diagnostic[])]),
    "complete",
    "$.additionalDiagnostics",
  );
}

/** Resolve B08 against F15's policy-filtered diagnostic multiset for reporting only. */
export function finalizeScheduledSyntaxSuppressions(
  evaluation: unknown,
  scheduledDiagnostics: unknown,
): SyntaxSuppressionFinalizationResult {
  return finalizeIssuedSyntaxSuppressions(
    evaluation,
    scheduledDiagnostics,
    "scheduled-reporting",
    "$.scheduledDiagnostics",
  );
}

/** Return the unforgeable same-process issuance class, or null for copies and foreign values. */
export function getSyntaxSuppressionFinalizationIssuance(
  finalization: unknown,
): SyntaxSuppressionFinalizationIssuance | null {
  if (finalization === null || typeof finalization !== "object" || nodeTypes.isProxy(finalization))
    return null;
  return issuedFinalizations.get(finalization)?.issuance ?? null;
}

function finalizeIssuedSyntaxSuppressions(
  evaluation: unknown,
  suppliedDiagnostics: unknown,
  issuance: SyntaxSuppressionFinalizationIssuance,
  diagnosticPath: "$.additionalDiagnostics" | "$.scheduledDiagnostics",
): SyntaxSuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const diagnosticsValue = array(suppliedDiagnostics, MAX_DIAGNOSTICS_PER_BUNDLE);
  if (diagnosticsValue === undefined)
    return finalizationFailure(
      issue("invalid-input", diagnosticPath, "must be a bounded dense array"),
    );
  const result = evaluation as Extract<SyntaxStructureRuleResult, { readonly ok: true }>;
  const applicable: DiagnosticBundle = Object.freeze({
    ...result.bundle,
    diagnostics: Object.freeze(
      [...(diagnosticsValue as readonly Diagnostic[])].sort(compareDiagnostics),
    ),
  });
  if (!validateDiagnosticBundle(applicable, issued.ir.sources).ok)
    return finalizationFailure(
      issue("invalid-input", diagnosticPath, "must contain valid B04 diagnostics"),
    );
  try {
    const matched = matchSuppressionDirectives(applicable, issued.directives, issued.ir.sources);
    const diagnostics = [...matched.bundle.diagnostics];
    const eligible: IssuedMechanicalDiagnostic[] = [];
    for (const suppression of matched.bundle.suppressions) {
      if (suppression.state !== "unused") continue;
      const before = diagnostics.length;
      if (before >= MAX_DIAGNOSTICS_PER_BUNDLE)
        return finalizationFailure(
          issue(
            "resource-limit",
            "$output.diagnostics",
            "generated diagnostics exceed the B04 limit",
          ),
        );
      addDiagnostic(diagnostics, {
        anchor: `suppression:${suppression.id}`,
        components: [
          { key: "rules", value: suppression.targetRuleIds.join(",") },
          { key: "suppression-id", value: suppression.id },
        ],
        message: "Suppression directive does not match a diagnostic on its target line.",
        primary: suppression.directive,
        ruleId: "ACL109",
        suggestion:
          "Remove the stale directive or place it immediately before the intended finding.",
      });
      const diagnostic = diagnostics[before];
      const directive = issued.directives.find((entry) => entry.record.id === suppression.id);
      if (diagnostic === undefined || directive === undefined)
        return finalizationFailure(
          issue("dependency-failure", "$output", "unused suppression ownership was lost"),
        );
      if (issuance === "complete") eligible.push(Object.freeze({ diagnostic, directive }));
    }
    const bundle: DiagnosticBundle = Object.freeze({
      ...matched.bundle,
      diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
    });
    const validated = validateDiagnosticBundle(bundle, issued.ir.sources);
    if (!validated.ok)
      return finalizationFailure(
        issue("dependency-failure", "$output", "generated output failed B04 validation"),
      );
    const suppressedIds = new Set(
      matched.suppressedDiagnostics.map((entry) => entry.diagnostic.id),
    );
    const output = Object.freeze({
      bundle: validated.value,
      ok: true,
      suppressedDiagnostics: Object.freeze(
        validated.value.diagnostics.filter((entry) => suppressedIds.has(entry.id)),
      ),
      visibleDiagnostics: Object.freeze(
        validated.value.diagnostics.filter((entry) => !suppressedIds.has(entry.id)),
      ),
    });
    issuedFinalizations.set(
      output,
      Object.freeze({ eligible: Object.freeze(eligible), ir: issued.ir, issuance }),
    );
    return output;
  } catch {
    return finalizationFailure(
      issue("dependency-failure", "$", "the suppression processor rejected the validated input"),
    );
  }
}

function sameLocation(left: DiagnosticSourceLocation, right: DiagnosticSourceLocation): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.path === right.path &&
    left.sourceDigest === right.sourceDigest &&
    left.range.sourceId === right.range.sourceId &&
    left.range.start.byteOffset === right.range.start.byteOffset &&
    left.range.start.utf16Offset === right.range.start.utf16Offset &&
    left.range.start.line === right.range.start.line &&
    left.range.start.utf16Column === right.range.start.utf16Column &&
    left.range.end.byteOffset === right.range.end.byteOffset &&
    left.range.end.utf16Offset === right.range.end.utf16Offset &&
    left.range.end.line === right.range.end.line &&
    left.range.end.utf16Column === right.range.end.utf16Column
  );
}

function approvedPlan(
  source: SourceDocument,
  diagnostic: Diagnostic,
  directive: ParsedSuppressionDirective,
): AtomicFixPlan | null | undefined {
  const primary = diagnostic.primary;
  if (
    diagnostic.ruleId !== "ACL109" ||
    diagnostic.ruleVersion !== SYNTAX_STRUCTURE_RULE_VERSION ||
    !sameLocation(primary, directive.record.directive) ||
    directive.record.state !== "applicable" ||
    source.id !== primary.sourceId ||
    source.path !== primary.path ||
    source.sha256 !== primary.sourceDigest
  )
    return undefined;
  const expected = source.text.slice(
    primary.range.start.utf16Offset,
    primary.range.end.utf16Offset,
  );
  if (
    primary.range.end.byteOffset - primary.range.start.byteOffset !==
    Buffer.byteLength(expected, "utf8")
  )
    return undefined;
  if (
    !expected.startsWith("<!--") ||
    !expected.endsWith("-->") ||
    !expected.includes("agent-context-lint-disable-next-line")
  )
    return null;
  const expectedSha256 = createHash("sha256").update(expected, "utf8").digest("hex");
  return Object.freeze({
    application: "atomic",
    id: `fix:acl109:${sha256(directive.record.id, source.sha256, expectedSha256).slice(0, 32)}` as FixPlanId,
    operations: Object.freeze([
      Object.freeze({
        kind: "text-edit" as const,
        newText: "",
        path: source.path,
        range: primary.range,
        sourceDigest: source.sha256,
        sourceId: source.id,
      }),
    ]),
    safety: "mechanical",
    title: "Remove exact unused suppression directive",
  });
}

const COMPLETE_F05_SUPPRESSION_TARGETS: ReadonlySet<string> = new Set([
  "ACL100",
  "ACL101",
  "ACL102",
  "ACL103",
  "ACL104",
  "ACL105",
  "ACL106",
  "ACL107",
  "ACL108",
]);

function hasCompleteF05SuppressionEvidence(directive: ParsedSuppressionDirective): boolean {
  const targets = directive.record.targetRuleIds;
  return targets.length === 1 && COMPLETE_F05_SUPPRESSION_TARGETS.has(targets[0] ?? "");
}

/**
 * Convert only parser-owned ACL109 findings into I11 capabilities. Copies, forged finalizations,
 * repository data, and every non-approved rule fail closed and can never mint authority.
 */
export function planApprovedMechanicalFixes(finalization: unknown): ApprovedMechanicalFixResult {
  if (finalization === null || typeof finalization !== "object" || nodeTypes.isProxy(finalization))
    return approvedMechanicalFailure(
      issue("invalid-input", "$.finalization", "must be an issued syntax finalization"),
    );
  const issued = issuedFinalizations.get(finalization);
  if (issued?.issuance !== "complete")
    return approvedMechanicalFailure(
      issue("invalid-input", "$.finalization", "must be an issued syntax finalization"),
    );
  const finalized = finalization as Extract<
    SyntaxSuppressionFinalizationResult,
    { readonly ok: true }
  >;
  const sourceById = new Map(issued.ir.sources.map((source) => [source.id, source]));
  const finalizedDiagnosticIdentities = new Set(finalized.bundle.diagnostics);
  const plans = new Map<
    string,
    {
      readonly diagnostic: Diagnostic;
      readonly plan: AtomicFixPlan;
    }
  >();
  for (const entry of issued.eligible) {
    if (!finalizedDiagnosticIdentities.has(entry.diagnostic))
      return approvedMechanicalFailure(
        issue("dependency-failure", "$output", "issued diagnostic identity was lost"),
      );
    if (!hasCompleteF05SuppressionEvidence(entry.directive)) continue;
    const source = sourceById.get(entry.diagnostic.primary.sourceId);
    const plan =
      source === undefined ? undefined : approvedPlan(source, entry.diagnostic, entry.directive);
    if (plan === null) continue;
    if (plan === undefined)
      return approvedMechanicalFailure(
        issue("dependency-failure", "$output", "approved mechanical proof did not reconcile"),
      );
    plans.set(entry.diagnostic.id, { diagnostic: entry.diagnostic, plan });
  }
  const diagnostics = finalized.bundle.diagnostics.map((diagnostic) => {
    const approved = plans.get(diagnostic.id);
    if (approved?.diagnostic !== diagnostic) return diagnostic;
    return Object.freeze({
      ...diagnostic,
      suggestion: Object.freeze({
        fixPlan: approved.plan,
        message: "Remove this exact parser-proven unused suppression comment.",
      }),
    });
  });
  const bundle: DiagnosticBundle = Object.freeze({
    ...finalized.bundle,
    diagnostics: Object.freeze(diagnostics),
  });
  const validation = validateDiagnosticBundle(bundle, issued.ir.sources);
  if (!validation.ok)
    return approvedMechanicalFailure(
      issue("dependency-failure", "$output", "approved fix bundle failed B04 validation"),
    );
  const candidates = diagnostics
    .flatMap((diagnostic) => {
      const plan = diagnostic.suggestion?.fixPlan;
      const approved = plans.get(diagnostic.id);
      if (
        diagnostic.ruleId !== "ACL109" ||
        plan === null ||
        plan === undefined ||
        approved?.plan !== plan
      )
        return [];
      return [
        issueSafeFixEligibility({
          confidence: 1,
          diagnosticId: diagnostic.id,
          plan,
          policyState: "eligible",
          ruleId: diagnostic.ruleId,
          ruleVersion: diagnostic.ruleVersion,
        }),
      ];
    })
    .sort((left, right) => compareUtf8(left.planId, right.planId));
  return Object.freeze({
    bundle: validation.value,
    candidates: Object.freeze(candidates),
    contractVersion: SYNTAX_STRUCTURE_RULE_CONTRACT_VERSION,
    eligiblePlanIds: Object.freeze(candidates.map((candidate) => candidate.planId)),
    ok: true,
    sources: Object.freeze([...issued.ir.sources]),
  });
}
