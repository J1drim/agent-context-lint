import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
  DIAGNOSTIC_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
} from "@agent-context/core";
import type {
  AstNodeId,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticFingerprintBasis,
  DiagnosticId,
  DiagnosticSourceLocation,
  InstructionDocumentId,
  InstructionStatementId,
  RelatedEvidence,
  RelatedEvidenceId,
  RepositoryFactRelatedEvidence,
  RepositoryRelativePath,
  SourceRange,
} from "@agent-context/core";
import {
  COMMAND_LEXER_CONTRACT_VERSION,
  EVIDENCE_INDEX_CONTRACT_VERSION,
  lexCommandEvidence,
  normalizeAndClassifyStatement,
  STATEMENT_CLASSIFIER_CONTRACT_VERSION,
} from "@agent-context/evidence";
import type {
  CommandDialect,
  CommandInvocationEvidence,
  EvidenceFact,
  EvidenceFactCategory,
  RepositoryEvidenceIndex,
  StatementClassifierResult,
} from "@agent-context/evidence";

export const REPOSITORY_DRIFT_CONTRACT_VERSION = "0.1.0" as const;
export const REPOSITORY_DRIFT_RULE_VERSION = "1.0.0" as const;
export const REPOSITORY_DRIFT_RULE_IDS = [
  "ACL300",
  "ACL301",
  "ACL302",
  "ACL303",
  "ACL304",
  "ACL305",
] as const;

export type RepositoryDriftRuleId = (typeof REPOSITORY_DRIFT_RULE_IDS)[number];

export interface RepositoryDriftStatementInput {
  readonly dialect: CommandDialect;
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  readonly path: RepositoryRelativePath;
  readonly range: SourceRange;
  readonly sourceDigest: string;
  readonly statementId: InstructionStatementId;
  readonly text: string;
}

export interface RepositoryDriftLimits {
  readonly maximumDiagnostics: number;
  readonly maximumFacts: number;
  readonly maximumRelatedFacts: number;
  readonly maximumStatements: number;
  readonly maximumTextLength: number;
  readonly maximumUncertainties: number;
}

export type RepositoryDriftOptions = Partial<RepositoryDriftLimits>;

export const REPOSITORY_DRIFT_DEFAULT_LIMITS: Readonly<RepositoryDriftLimits> = Object.freeze({
  maximumDiagnostics: 50_000,
  maximumFacts: 250_000,
  maximumRelatedFacts: 64,
  maximumStatements: 10_000,
  maximumTextLength: 65_536,
  maximumUncertainties: 50_000,
});

export const REPOSITORY_DRIFT_HARD_LIMITS: Readonly<RepositoryDriftLimits> = Object.freeze({
  maximumDiagnostics: 250_000,
  maximumFacts: 1_000_000,
  maximumRelatedFacts: 1_024,
  maximumStatements: 100_000,
  maximumTextLength: 1_048_576,
  maximumUncertainties: 250_000,
});

export type RepositoryDriftUncertaintyReason =
  | "ambiguous-command-dialect"
  | "ambiguous-task-resolution"
  | "dynamic-command"
  | "evidence-conflict"
  | "evidence-index-uncertain"
  | "optional-task-reference"
  | "pattern-task-reference"
  | "unsupported-runtime-constraint";

export interface RepositoryDriftUncertainty {
  readonly reason: RepositoryDriftUncertaintyReason;
  readonly ruleId: RepositoryDriftRuleId;
  readonly statementId: InstructionStatementId;
  readonly subject: string;
}

export interface RepositoryDriftMetrics {
  readonly commandInvocationCount: number;
  readonly diagnosticCount: number;
  readonly evidenceFactCount: number;
  readonly statementCount: number;
  readonly uncertaintyCount: number;
}

export interface RepositoryDriftResult {
  readonly bundle: DiagnosticBundle;
  readonly commandLexerContractVersion: typeof COMMAND_LEXER_CONTRACT_VERSION;
  readonly contractVersion: typeof REPOSITORY_DRIFT_CONTRACT_VERSION;
  readonly evidenceIndexContractVersion: typeof EVIDENCE_INDEX_CONTRACT_VERSION;
  readonly limits: RepositoryDriftLimits;
  readonly metrics: RepositoryDriftMetrics;
  readonly statementClassifierContractVersion: typeof STATEMENT_CLASSIFIER_CONTRACT_VERSION;
  readonly uncertainties: readonly RepositoryDriftUncertainty[];
}

export const RepositoryDriftErrorCode: Readonly<{
  invalidInput: "REPOSITORY_DRIFT_INVALID_INPUT";
  invalidOptions: "REPOSITORY_DRIFT_INVALID_OPTIONS";
  limitExceeded: "REPOSITORY_DRIFT_LIMIT_EXCEEDED";
}> = Object.freeze({
  invalidInput: "REPOSITORY_DRIFT_INVALID_INPUT",
  invalidOptions: "REPOSITORY_DRIFT_INVALID_OPTIONS",
  limitExceeded: "REPOSITORY_DRIFT_LIMIT_EXCEEDED",
});

export type RepositoryDriftErrorCode =
  (typeof RepositoryDriftErrorCode)[keyof typeof RepositoryDriftErrorCode];

export class RepositoryDriftError extends Error {
  override readonly name = "RepositoryDriftError" as const;
  readonly code: RepositoryDriftErrorCode;
  readonly limitName: keyof RepositoryDriftLimits | null;

  constructor(
    code: RepositoryDriftErrorCode,
    message: string,
    limitName: keyof RepositoryDriftLimits | null = null,
  ) {
    super(message);
    this.code = code;
    this.limitName = limitName;
    Object.freeze(this);
  }
}

interface ValidatedStatement extends RepositoryDriftStatementInput {
  readonly classification: StatementClassifierResult;
}

type FactSnapshot = EvidenceFact;

interface TaskReference {
  readonly kind: "script" | "task";
  readonly provider: "just" | "make" | "npm" | "pnpm";
  readonly state: "definite" | "optional" | "pattern";
  readonly subject: string;
}

interface RuntimeRequirement {
  readonly displayName: string;
  readonly major: number;
  readonly minor: number | null;
  readonly name: string;
}

interface EvaluationContext {
  readonly diagnostics: Diagnostic[];
  readonly diagnosticKeys: Set<string>;
  readonly factCatalog: FactCatalog;
  readonly indexUncertain: boolean;
  readonly limits: RepositoryDriftLimits;
  readonly uncertainties: RepositoryDriftUncertainty[];
  readonly uncertaintyKeys: Set<string>;
  commandInvocationCount: number;
}

interface FactCatalog {
  readonly byCategory: ReadonlyMap<EvidenceFactCategory, readonly FactSnapshot[]>;
  readonly byCategoryAndName: ReadonlyMap<
    EvidenceFactCategory,
    ReadonlyMap<string, readonly FactSnapshot[]>
  >;
}

const STATEMENT_KEYS = new Set([
  "dialect",
  "documentId",
  "nodeIds",
  "path",
  "range",
  "sourceDigest",
  "statementId",
  "text",
]);
const INDEX_KEYS = new Set([
  "conflicts",
  "contractVersion",
  "facts",
  "issues",
  "limits",
  "metrics",
  "uncertainty",
  "uncertaintyReasons",
]);
const FACT_KEYS = new Set([
  "category",
  "certainty",
  "id",
  "location",
  "name",
  "provenance",
  "rawValue",
  "scope",
  "value",
]);
const LOCATION_KEYS = new Set(["path", "range"]);
const CONFIG_RANGE_KEYS = new Set(["end", "start"]);
const POSITION_KEYS = new Set(["byteOffset", "line", "utf16Column", "utf16Offset"]);
const PROVENANCE_KEYS = new Set(["collectorId", "interpretation", "sourceState"]);
const LIMIT_KEYS = new Set(Object.keys(REPOSITORY_DRIFT_DEFAULT_LIMITS));
const COMMAND_DIALECT_SET = new Set<CommandDialect>([
  "auto",
  "posix-shell",
  "windows-cmd",
  "windows-powershell",
]);
const FACT_CATEGORIES = new Set<EvidenceFactCategory>([
  "ci",
  "lockfile",
  "manifest",
  "package-manager",
  "path",
  "runtime",
  "script",
  "task",
  "tool",
]);
const FACT_CERTAINTIES = new Set(["declared", "observed-path", "uncertain"]);
const INTERPRETATIONS = new Set(["inert-text", "path-only", "workspace-evidence"]);
const SOURCE_STATES = new Set(["complete", "malformed", "path-only", "unavailable", "unsupported"]);
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const TOOL_NAMES = new Set([
  "biome",
  "black",
  "clang-format",
  "deno",
  "eslint",
  "flake8",
  "gofmt",
  "golangci-lint",
  "mypy",
  "prettier",
  "pylint",
  "pyright",
  "ruff",
  "rustfmt",
  "stylelint",
]);
const RULE_SEVERITY: Readonly<Record<RepositoryDriftRuleId, Diagnostic["severity"]>> =
  Object.freeze({
    ACL300: "error",
    ACL301: "warning",
    ACL302: "warning",
    ACL303: "warning",
    ACL304: "warning",
    ACL305: "info",
  });

function failInput(message: string): never {
  throw new RepositoryDriftError(RepositoryDriftErrorCode.invalidInput, message);
}

function record(
  value: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
  code: RepositoryDriftErrorCode = RepositoryDriftErrorCode.invalidInput,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    throw new RepositoryDriftError(code, `${name} must be a non-proxy plain object`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new RepositoryDriftError(code, `${name} must have a plain prototype`);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new RepositoryDriftError(code, `${name} could not be inspected safely`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key))
      throw new RepositoryDriftError(code, `${name} contains an unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      throw new RepositoryDriftError(code, `${name} must contain only own data properties`);
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value))
    return failInput(`${name} must be a non-proxy array`);
  if (value.length > maximum)
    throw new RepositoryDriftError(
      RepositoryDriftErrorCode.limitExceeded,
      `${name} exceeds its resource limit`,
      name === "statements" ? "maximumStatements" : "maximumFacts",
    );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length),
    )
  )
    return failInput(`${name} must be dense and contain no extra properties`);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor))
      return failInput(`${name} must contain only own data properties`);
    output.push(descriptor.value);
  }
  return output;
}

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum)
    return failInput(`${name} must be a bounded string`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
        return failInput(`${name} must contain well-formed Unicode`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      return failInput(`${name} must contain well-formed Unicode`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const output = text(value, name, 512);
  if (!STABLE_IDENTIFIER.test(output)) return failInput(`${name} must be a stable identifier`);
  return output;
}

function natural(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    return failInput(`${name} must be a non-negative safe integer`);
  return value as number;
}

function position(
  value: unknown,
  name: string,
): {
  readonly byteOffset: number;
  readonly line: number;
  readonly utf16Column: number;
  readonly utf16Offset: number;
} {
  const item = record(value, name, POSITION_KEYS);
  return Object.freeze({
    byteOffset: natural(item["byteOffset"], `${name}.byteOffset`),
    line: natural(item["line"], `${name}.line`),
    utf16Column: natural(item["utf16Column"], `${name}.utf16Column`),
    utf16Offset: natural(item["utf16Offset"], `${name}.utf16Offset`),
  });
}

function configurationRange(value: unknown, name: string): EvidenceFact["location"]["range"] {
  const item = record(value, name, CONFIG_RANGE_KEYS);
  const start = position(item["start"], `${name}.start`);
  const end = position(item["end"], `${name}.end`);
  if (
    end.byteOffset < start.byteOffset ||
    end.utf16Offset < start.utf16Offset ||
    end.line < start.line ||
    (end.line === start.line && end.utf16Column < start.utf16Column)
  )
    return failInput(`${name} must not be reversed`);
  return Object.freeze({ end, start });
}

function repositoryPath(value: unknown, name: string): RepositoryRelativePath {
  const input = text(value, name, 4_096);
  try {
    const canonical = canonicalizeRepositoryRelativePath(input);
    if (canonical !== input) return failInput(`${name} must be canonical repository-relative`);
    return canonical;
  } catch {
    return failInput(`${name} must be canonical repository-relative`);
  }
}

function validateLimit(value: unknown, name: keyof RepositoryDriftLimits): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > REPOSITORY_DRIFT_HARD_LIMITS[name]
  )
    throw new RepositoryDriftError(
      RepositoryDriftErrorCode.invalidOptions,
      `${name} must be a positive safe integer no greater than ${String(REPOSITORY_DRIFT_HARD_LIMITS[name])}`,
      name,
    );
  return value as number;
}

function validateOptions(value: unknown): RepositoryDriftLimits {
  if (value === undefined) return REPOSITORY_DRIFT_DEFAULT_LIMITS;
  const options = record(value, "options", LIMIT_KEYS, RepositoryDriftErrorCode.invalidOptions);
  const output: Record<string, number> = {};
  for (const key of LIMIT_KEYS as ReadonlySet<keyof RepositoryDriftLimits>)
    output[key] = validateLimit(
      Object.hasOwn(options, key) ? options[key] : REPOSITORY_DRIFT_DEFAULT_LIMITS[key],
      key,
    );
  return Object.freeze(output) as unknown as RepositoryDriftLimits;
}

function validateStatements(
  value: unknown,
  limits: RepositoryDriftLimits,
): readonly ValidatedStatement[] {
  const values = denseArray(value, "statements", limits.maximumStatements);
  const output: ValidatedStatement[] = [];
  let previous = "";
  for (const [index, raw] of values.entries()) {
    const name = `statements[${String(index)}]`;
    const item = record(raw, name, STATEMENT_KEYS);
    const statementId = identifier(item["statementId"], `${name}.statementId`);
    if (statementId <= previous)
      return failInput("statements must be sorted by unique statementId");
    previous = statementId;
    const dialect = item["dialect"];
    if (typeof dialect !== "string" || !COMMAND_DIALECT_SET.has(dialect as CommandDialect))
      return failInput(`${name}.dialect is unsupported`);
    const sourceDigest = text(item["sourceDigest"], `${name}.sourceDigest`, 64);
    if (!SHA256.test(sourceDigest))
      return failInput(`${name}.sourceDigest must be lowercase SHA-256`);
    let classification: StatementClassifierResult;
    try {
      classification = normalizeAndClassifyStatement(
        {
          documentId: item["documentId"],
          nodeIds: item["nodeIds"],
          range: item["range"],
          statementId,
          text: item["text"],
        },
        { maximumInputLength: limits.maximumTextLength },
      );
    } catch (error) {
      if (error instanceof Error) return failInput(`${name} is not valid F03 statement input`);
      throw error;
    }
    output.push(
      Object.freeze({
        dialect: dialect as CommandDialect,
        documentId: classification.statement.documentId,
        nodeIds: classification.statement.nodeIds,
        path: repositoryPath(item["path"], `${name}.path`),
        range: classification.statement.range,
        sourceDigest,
        statementId: classification.statement.id,
        text: classification.statement.text,
        classification,
      }),
    );
  }
  return Object.freeze(output);
}

function validateFact(value: unknown, name: string, limits: RepositoryDriftLimits): FactSnapshot {
  const item = record(value, name, FACT_KEYS);
  const category = item["category"];
  if (typeof category !== "string" || !FACT_CATEGORIES.has(category as EvidenceFactCategory))
    return failInput(`${name}.category is unsupported`);
  const certainty = item["certainty"];
  if (typeof certainty !== "string" || !FACT_CERTAINTIES.has(certainty))
    return failInput(`${name}.certainty is unsupported`);
  const locationItem = record(item["location"], `${name}.location`, LOCATION_KEYS);
  const provenanceItem = record(item["provenance"], `${name}.provenance`, PROVENANCE_KEYS);
  const interpretation = provenanceItem["interpretation"];
  const sourceState = provenanceItem["sourceState"];
  if (typeof interpretation !== "string" || !INTERPRETATIONS.has(interpretation))
    return failInput(`${name}.provenance.interpretation is unsupported`);
  if (typeof sourceState !== "string" || !SOURCE_STATES.has(sourceState))
    return failInput(`${name}.provenance.sourceState is unsupported`);
  return Object.freeze({
    category: category as EvidenceFactCategory,
    certainty: certainty as EvidenceFact["certainty"],
    id: identifier(item["id"], `${name}.id`),
    location: Object.freeze({
      path: repositoryPath(locationItem["path"], `${name}.location.path`),
      range: configurationRange(locationItem["range"], `${name}.location.range`),
    }),
    name: text(item["name"], `${name}.name`, limits.maximumTextLength),
    provenance: Object.freeze({
      collectorId: identifier(provenanceItem["collectorId"], `${name}.provenance.collectorId`),
      interpretation: interpretation as EvidenceFact["provenance"]["interpretation"],
      sourceState: sourceState as EvidenceFact["provenance"]["sourceState"],
    }),
    rawValue: text(item["rawValue"], `${name}.rawValue`, limits.maximumTextLength),
    scope: repositoryPath(item["scope"], `${name}.scope`),
    value: text(item["value"], `${name}.value`, limits.maximumTextLength),
  });
}

function validateIndex(
  value: unknown,
  limits: RepositoryDriftLimits,
): { readonly facts: readonly FactSnapshot[]; readonly uncertain: boolean } {
  const item = record(value, "evidenceIndex", INDEX_KEYS);
  if (item["contractVersion"] !== EVIDENCE_INDEX_CONTRACT_VERSION)
    return failInput("evidenceIndex.contractVersion is unsupported");
  if (item["uncertainty"] !== "known" && item["uncertainty"] !== "uncertain")
    return failInput("evidenceIndex.uncertainty is unsupported");
  const facts = denseArray(item["facts"], "evidenceIndex.facts", limits.maximumFacts).map(
    (fact, index) => validateFact(fact, `evidenceIndex.facts[${String(index)}]`, limits),
  );
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) return failInput("evidenceIndex facts must have unique IDs");
    ids.add(fact.id);
  }
  return Object.freeze({
    facts: Object.freeze(
      [...facts].sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1)),
    ),
    uncertain: item["uncertainty"] === "uncertain",
  });
}

function appliesToPath(scope: RepositoryRelativePath, path: RepositoryRelativePath): boolean {
  return scope === "." || path === scope || path.startsWith(`${scope}/`);
}

function buildFactCatalog(facts: readonly FactSnapshot[]): FactCatalog {
  const byCategory = new Map<EvidenceFactCategory, FactSnapshot[]>();
  const byCategoryAndName = new Map<EvidenceFactCategory, Map<string, FactSnapshot[]>>();
  for (const fact of facts) {
    const categoryFacts = byCategory.get(fact.category);
    if (categoryFacts === undefined) byCategory.set(fact.category, [fact]);
    else categoryFacts.push(fact);
    let names = byCategoryAndName.get(fact.category);
    if (names === undefined) {
      names = new Map();
      byCategoryAndName.set(fact.category, names);
    }
    const namedFacts = names.get(fact.name);
    if (namedFacts === undefined) names.set(fact.name, [fact]);
    else namedFacts.push(fact);
  }
  return {
    byCategory: new Map(
      [...byCategory].map(([category, values]) => [category, Object.freeze(values)] as const),
    ),
    byCategoryAndName: new Map(
      [...byCategoryAndName].map(([category, names]) => [
        category,
        new Map([...names].map(([name, values]) => [name, Object.freeze(values)] as const)),
      ]),
    ),
  };
}

function scopedFacts(
  catalog: FactCatalog,
  path: RepositoryRelativePath,
  category: EvidenceFactCategory,
  name?: string,
): readonly FactSnapshot[] {
  const candidates =
    name === undefined
      ? (catalog.byCategory.get(category) ?? [])
      : (catalog.byCategoryAndName.get(category)?.get(name) ?? []);
  const matching = candidates.filter((fact) => appliesToPath(fact.scope, path));
  if (matching.length === 0) return Object.freeze([]);
  const maximumScopeLength = Math.max(...matching.map((fact) => fact.scope.length));
  return Object.freeze(matching.filter((fact) => fact.scope.length === maximumScopeLength));
}

function positiveFacts(facts: readonly FactSnapshot[]): readonly FactSnapshot[] {
  return facts.filter(
    (fact) =>
      fact.certainty !== "uncertain" &&
      (fact.provenance.sourceState === "complete" || fact.provenance.sourceState === "path-only"),
  );
}

function hasIncompleteFacts(facts: readonly FactSnapshot[]): boolean {
  return facts.some(
    (fact) =>
      fact.certainty === "uncertain" ||
      (fact.provenance.sourceState !== "complete" && fact.provenance.sourceState !== "path-only"),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function primary(statement: ValidatedStatement): DiagnosticSourceLocation {
  return Object.freeze({
    path: statement.path,
    range: statement.range,
    sourceDigest: statement.sourceDigest,
    sourceId: statement.range.sourceId,
  });
}

function relatedFact(ruleId: RepositoryDriftRuleId, fact: FactSnapshot): RelatedEvidence {
  return Object.freeze({
    collectorId: fact.provenance.collectorId,
    factId: fact.id,
    id: `evidence:${ruleId}:${fact.id}` as RelatedEvidenceId,
    kind: "repository-fact",
    label: "repository evidence",
    locations: Object.freeze([]),
    subjectPath: fact.scope,
    valueDigest: sha256(JSON.stringify([fact.category, fact.name, fact.value, fact.scope])),
  } satisfies RepositoryFactRelatedEvidence);
}

function addUncertainty(
  context: EvaluationContext,
  statement: ValidatedStatement,
  ruleId: RepositoryDriftRuleId,
  reason: RepositoryDriftUncertaintyReason,
  subject: string,
): void {
  const safeSubject = SAFE_SUBJECT.test(subject) ? subject : "unresolved";
  const key = `${statement.statementId}\u0000${ruleId}\u0000${reason}\u0000${safeSubject}`;
  if (context.uncertaintyKeys.has(key)) return;
  if (context.uncertainties.length >= context.limits.maximumUncertainties)
    throw new RepositoryDriftError(
      RepositoryDriftErrorCode.limitExceeded,
      "maximumUncertainties was exceeded",
      "maximumUncertainties",
    );
  context.uncertaintyKeys.add(key);
  context.uncertainties.push(
    Object.freeze({ reason, ruleId, statementId: statement.statementId, subject: safeSubject }),
  );
}

function addDiagnostic(
  context: EvaluationContext,
  statement: ValidatedStatement,
  ruleId: RepositoryDriftRuleId,
  subject: string,
  message: string,
  facts: readonly FactSnapshot[] = [],
): void {
  const key = `${statement.statementId}\u0000${ruleId}\u0000${subject}`;
  if (context.diagnosticKeys.has(key)) return;
  context.diagnosticKeys.add(key);
  if (context.diagnostics.length >= context.limits.maximumDiagnostics)
    throw new RepositoryDriftError(
      RepositoryDriftErrorCode.limitExceeded,
      "maximumDiagnostics was exceeded",
      "maximumDiagnostics",
    );
  const pathBasis: DiagnosticFingerprintBasis["path"] = Object.freeze({
    anchor: `statement:${statement.statementId}`,
    profileIds: Object.freeze([]),
  });
  const semanticBasis: DiagnosticFingerprintBasis["semantic"] = Object.freeze({
    components: Object.freeze([
      Object.freeze({ key: "statement", value: statement.statementId }),
      Object.freeze({ key: "subject", value: subject }),
    ]),
    profileIds: Object.freeze([]),
  });
  const pathFingerprint = computePathFingerprint({
    basis: pathBasis,
    path: statement.path,
    ruleId,
    ruleVersion: REPOSITORY_DRIFT_RULE_VERSION,
  });
  const semanticFingerprint = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId,
    ruleVersion: REPOSITORY_DRIFT_RULE_VERSION,
  });
  const relatedFacts = positiveFacts(facts);
  if (relatedFacts.length > context.limits.maximumRelatedFacts)
    throw new RepositoryDriftError(
      RepositoryDriftErrorCode.limitExceeded,
      "maximumRelatedFacts was exceeded",
      "maximumRelatedFacts",
    );
  const related = Object.freeze(
    relatedFacts
      .map((fact) => relatedFact(ruleId, fact))
      .sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1)),
  );
  context.diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({ method: PATH_FINGERPRINT_METHOD, value: pathFingerprint }),
        semantic: Object.freeze({
          method: SEMANTIC_FINGERPRINT_METHOD,
          value: semanticFingerprint,
        }),
      }),
      id: `diagnostic:${ruleId}:${semanticFingerprint.slice(0, 24)}` as DiagnosticId,
      message,
      primary: primary(statement),
      related,
      ruleId,
      ruleVersion: REPOSITORY_DRIFT_RULE_VERSION,
      severity: RULE_SEVERITY[ruleId],
      suggestion: null,
    }),
  );
}

function literal(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && SAFE_SUBJECT.test(value) ? value : null;
}

function taskReferences(invocation: CommandInvocationEvidence): readonly TaskReference[] {
  if (invocation.state !== "literal") return Object.freeze([]);
  const executable = literal(invocation.executable);
  const args = invocation.arguments;
  if (executable === "npm" || executable === "pnpm") {
    if (!["run", "run-script"].includes(args[0] ?? "")) return Object.freeze([]);
    if (args.some((argument) => argument === "--if-present")) {
      const subject = literal(
        args.find((argument, index) => index > 0 && !argument?.startsWith("-")),
      );
      return subject === null
        ? Object.freeze([])
        : Object.freeze([{ kind: "script", provider: executable, state: "optional", subject }]);
    }
    if (executable === "pnpm" && args[1]?.startsWith("/") === true && args[1].endsWith("/"))
      return Object.freeze([
        { kind: "script", provider: executable, state: "pattern", subject: "pnpm-pattern" },
      ]);
    const subject = literal(args[1]);
    if (subject === null || subject.startsWith("/") || subject.startsWith("-"))
      return Object.freeze([]);
    return Object.freeze([{ kind: "script", provider: executable, state: "definite", subject }]);
  }
  if (executable === "make" || executable === "just") {
    const subject = literal(args[0]);
    if (subject === null || subject.startsWith("-")) return Object.freeze([]);
    return Object.freeze([{ kind: "task", provider: executable, state: "definite", subject }]);
  }
  return Object.freeze([]);
}

function ambiguousTaskSubject(invocation: CommandInvocationEvidence): string | null {
  if (invocation.state !== "literal") return null;
  if (invocation.executable === "yarn") {
    const first = invocation.arguments[0];
    if (first === "exec") return null;
    return literal(first === "run" ? invocation.arguments[1] : first);
  }
  if (invocation.executable === "bun") {
    const first = invocation.arguments[0];
    return literal(first === "run" ? invocation.arguments[1] : first);
  }
  return null;
}

function evaluateTaskReference(
  context: EvaluationContext,
  statement: ValidatedStatement,
  reference: TaskReference,
): void {
  if (reference.state === "optional") {
    addUncertainty(context, statement, "ACL300", "optional-task-reference", reference.subject);
    return;
  }
  if (reference.state === "pattern") {
    addUncertainty(context, statement, "ACL300", "pattern-task-reference", reference.subject);
    return;
  }
  const category = reference.kind === "script" ? "script" : "task";
  const candidates = scopedFacts(context.factCatalog, statement.path, category, reference.subject);
  const providerFacts =
    reference.kind === "task"
      ? candidates.filter((fact) => fact.value === reference.provider)
      : candidates;
  if (positiveFacts(providerFacts).length > 0) return;
  if (context.indexUncertain || hasIncompleteFacts(candidates)) {
    addUncertainty(context, statement, "ACL300", "evidence-index-uncertain", reference.subject);
    return;
  }
  addDiagnostic(
    context,
    statement,
    "ACL300",
    `${reference.provider}:${reference.subject}`,
    `Referenced ${reference.provider} ${reference.kind} '${reference.subject}' is not declared in the applicable repository scope.`,
  );
}

function evaluateAmbiguousTaskReference(
  context: EvaluationContext,
  statement: ValidatedStatement,
  subject: string,
): void {
  const scripts = scopedFacts(context.factCatalog, statement.path, "script", subject);
  if (positiveFacts(scripts).length > 0) return;
  addUncertainty(context, statement, "ACL300", "ambiguous-task-resolution", subject);
}

function evaluatePackageManager(
  context: EvaluationContext,
  statement: ValidatedStatement,
  invocation: CommandInvocationEvidence,
): void {
  const manager = literal(invocation.executable);
  if (manager === null || !PACKAGE_MANAGERS.has(manager)) return;
  const facts = scopedFacts(context.factCatalog, statement.path, "package-manager", "selected");
  const selected = [...new Set(positiveFacts(facts).map((fact) => fact.value))].sort();
  if (context.indexUncertain || hasIncompleteFacts(facts)) {
    addUncertainty(context, statement, "ACL301", "evidence-index-uncertain", manager);
    return;
  }
  if (selected.length > 1) {
    addUncertainty(context, statement, "ACL301", "evidence-conflict", manager);
    return;
  }
  const expected = selected[0];
  if (expected === undefined || expected === manager) return;
  addDiagnostic(
    context,
    statement,
    "ACL301",
    manager,
    `Command uses ${manager}, but applicable repository evidence selects ${expected}.`,
    facts,
  );
}

function commandPath(invocation: CommandInvocationEvidence): RepositoryRelativePath | null {
  if (invocation.state !== "literal" || invocation.executable === null) return null;
  const executable = invocation.executable;
  if (!executable.includes("/")) return null;
  try {
    return canonicalizeRepositoryRelativePath(executable);
  } catch {
    return null;
  }
}

function pathFactsForCandidate(
  catalog: FactCatalog,
  candidate: RepositoryRelativePath,
): readonly FactSnapshot[] {
  const prefix = candidate === "." ? "" : `${candidate}/`;
  return (catalog.byCategory.get("path") ?? []).filter(
    (fact) => fact.name === candidate || fact.name.startsWith(prefix),
  );
}

function evaluatePath(
  context: EvaluationContext,
  statement: ValidatedStatement,
  candidate: RepositoryRelativePath,
): void {
  const facts = pathFactsForCandidate(context.factCatalog, candidate);
  if (positiveFacts(facts).length > 0) return;
  if (context.indexUncertain || hasIncompleteFacts(facts)) {
    addUncertainty(context, statement, "ACL302", "evidence-index-uncertain", candidate);
    return;
  }
  addDiagnostic(
    context,
    statement,
    "ACL302",
    candidate,
    `Referenced repository path '${candidate}' is absent from the collected path inventory.`,
  );
}

function pathPolicyCandidates(
  classification: StatementClassifierResult,
): readonly RepositoryRelativePath[] {
  const output = new Set<RepositoryRelativePath>();
  for (const domain of classification.domains) {
    if (domain.domain !== "path-policy" || domain.object === null) continue;
    for (const part of domain.object.split(/\s*,\s*/u)) {
      const candidate = part.replace(/^['"`]|['"`]$/gu, "").replace(/\/$/u, "");
      if (
        candidate.length === 0 ||
        !SAFE_SUBJECT.test(candidate) ||
        /[*?{}$\\]/u.test(candidate) ||
        /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
      )
        continue;
      try {
        output.add(canonicalizeRepositoryRelativePath(candidate));
      } catch {
        continue;
      }
    }
  }
  return Object.freeze([...output].sort());
}

function commandTool(invocation: CommandInvocationEvidence): string | null {
  if (invocation.state !== "literal") return null;
  const executable = literal(invocation.executable);
  if (executable !== null && TOOL_NAMES.has(executable)) return executable;
  if (executable === "npx" || executable === "bunx") return literal(invocation.arguments[0]);
  if (executable === "pnpm" && invocation.arguments[0] === "exec")
    return literal(invocation.arguments[1]);
  if (executable === "yarn" && invocation.arguments[0] === "exec")
    return literal(invocation.arguments[1]);
  if (executable === "npm" && invocation.arguments[0] === "exec") {
    const target =
      invocation.arguments[1] === "--" ? invocation.arguments[2] : invocation.arguments[1];
    return literal(target);
  }
  return null;
}

function formattingTools(classification: StatementClassifierResult): readonly string[] {
  const output = new Set<string>();
  for (const domain of classification.domains)
    if (domain.domain === "formatting" && domain.object !== null && TOOL_NAMES.has(domain.object))
      output.add(domain.object);
  const lintMatch =
    /^(?:use|run)\s+(eslint|biome|ruff|black|flake8|mypy|pylint|stylelint|golangci-lint)\s+(?:for|to)\s+lint(?:ing)?\b/u.exec(
      classification.normalizedText,
    );
  if (lintMatch?.[1] !== undefined) output.add(lintMatch[1]);
  return Object.freeze([...output].sort());
}

function evaluateTool(
  context: EvaluationContext,
  statement: ValidatedStatement,
  tool: string,
): void {
  if (!TOOL_NAMES.has(tool)) return;
  const facts = scopedFacts(context.factCatalog, statement.path, "tool", tool);
  if (positiveFacts(facts).length > 0) return;
  if (context.indexUncertain || hasIncompleteFacts(facts)) {
    addUncertainty(context, statement, "ACL303", "evidence-index-uncertain", tool);
    return;
  }
  addDiagnostic(
    context,
    statement,
    "ACL303",
    tool,
    `Tool '${tool}' is not declared or configured in the applicable repository scope.`,
  );
}

function runtimeRequirement(normalizedText: string): RuntimeRequirement | null {
  const match =
    /^(?:use|require|target)\s+(node(?:\.js)?|nodejs|python(?:3)?|go(?:lang)?|rust(?:c)?|java|ruby)\s+(?:version\s+)?v?(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3})?\b/u.exec(
      normalizedText,
    ) ??
    /^(node(?:\.js)?|nodejs|python(?:3)?|go(?:lang)?|rust(?:c)?|java|ruby)\s+(?:version\s+)?(?:must be|should be|is|required is)\s+v?(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3})?\b/u.exec(
      normalizedText,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const aliases: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    go: ["go", "Go"],
    golang: ["go", "Go"],
    java: ["java", "Java"],
    node: ["node", "Node.js"],
    "node.js": ["node", "Node.js"],
    nodejs: ["node", "Node.js"],
    python: ["python", "Python"],
    python3: ["python", "Python"],
    ruby: ["ruby", "Ruby"],
    rust: ["rust", "Rust"],
    rustc: ["rust", "Rust"],
  });
  const alias = aliases[match[1]];
  if (alias === undefined) return null;
  return Object.freeze({
    displayName: alias[1],
    major: Number(match[2]),
    minor: match[3] === undefined ? null : Number(match[3]),
    name: alias[0],
  });
}

function configuredVersion(
  value: string,
): { readonly major: number; readonly minor: number | null; readonly minorExact: boolean } | null {
  const normalized = value.trim().replace(/^(?:node|go)?v/iu, "");
  if (/\|\||\*|\bx\b/iu.test(normalized)) return null;
  const exact = /^([=~^])?\s*(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3})?(?:-[0-9A-Za-z.-]+)?$/u.exec(
    normalized,
  );
  if (exact?.[2] !== undefined)
    return Object.freeze({
      major: Number(exact[2]),
      minor: exact[3] === undefined ? null : Number(exact[3]),
      minorExact: exact[1] !== "^",
    });
  return null;
}

function runtimeCompatibility(
  requirement: RuntimeRequirement,
  fact: FactSnapshot,
): "compatible" | "conflict" | "unknown" {
  const configured = configuredVersion(fact.value);
  if (configured === null) return "unknown";
  if (configured.major !== requirement.major) return "conflict";
  if (
    requirement.minor !== null &&
    configured.minor !== null &&
    configured.minor !== requirement.minor
  )
    return configured.minorExact ? "conflict" : "unknown";
  return "compatible";
}

function evaluateRuntime(context: EvaluationContext, statement: ValidatedStatement): void {
  const requirement = runtimeRequirement(statement.classification.normalizedText);
  if (requirement === null) return;
  const facts = scopedFacts(context.factCatalog, statement.path, "runtime", requirement.name);
  const positive = positiveFacts(facts);
  if (positive.length === 0) {
    if (context.indexUncertain || hasIncompleteFacts(facts))
      addUncertainty(context, statement, "ACL304", "evidence-index-uncertain", requirement.name);
    return;
  }
  const states = positive.map((fact) => runtimeCompatibility(requirement, fact));
  if (states.includes("compatible")) {
    if (states.includes("conflict"))
      addUncertainty(context, statement, "ACL304", "evidence-conflict", requirement.name);
    return;
  }
  if (context.indexUncertain || hasIncompleteFacts(facts)) {
    addUncertainty(context, statement, "ACL304", "evidence-index-uncertain", requirement.name);
    return;
  }
  if (states.includes("unknown")) {
    addUncertainty(
      context,
      statement,
      "ACL304",
      "unsupported-runtime-constraint",
      requirement.name,
    );
    return;
  }
  addDiagnostic(
    context,
    statement,
    "ACL304",
    `${requirement.name}:${String(requirement.major)}${requirement.minor === null ? "" : `.${String(requirement.minor)}`}`,
    `Documented ${requirement.displayName} version ${String(requirement.major)}${requirement.minor === null ? "" : `.${String(requirement.minor)}`} conflicts with applicable repository runtime evidence.`,
    facts,
  );
}

function evaluateMechanicalPolicy(context: EvaluationContext, statement: ValidatedStatement): void {
  for (const tool of formattingTools(statement.classification)) {
    const facts = scopedFacts(context.factCatalog, statement.path, "tool", tool);
    if (positiveFacts(facts).length === 0) continue;
    addDiagnostic(
      context,
      statement,
      "ACL305",
      tool,
      `Policy for '${tool}' is already represented by repository linter or formatter configuration.`,
      facts,
    );
  }
}

function evaluateStatement(context: EvaluationContext, statement: ValidatedStatement): void {
  evaluateRuntime(context, statement);
  evaluateMechanicalPolicy(context, statement);
  for (const candidate of pathPolicyCandidates(statement.classification))
    evaluatePath(context, statement, candidate);
  const commandDomain = statement.classification.domains.find(
    (domain) => domain.domain === "command",
  );
  if (commandDomain?.object === null || commandDomain?.object === undefined) return;
  const command = lexCommandEvidence({
    dialect: statement.dialect,
    provenance: {
      collectorId: "f09.statement-command",
      factId: null,
      source: {
        path: statement.path,
        range: { end: statement.range.end, start: statement.range.start },
      },
      sourceKind: "caller",
    },
    text: commandDomain.object,
  });
  if (command.resolvedDialect === null) {
    for (const ruleId of ["ACL300", "ACL301", "ACL302", "ACL303"] as const)
      addUncertainty(context, statement, ruleId, "ambiguous-command-dialect", "command");
    return;
  }
  for (const invocation of command.invocations) {
    context.commandInvocationCount += 1;
    if (invocation.state !== "literal") {
      for (const ruleId of ["ACL300", "ACL301", "ACL302", "ACL303"] as const)
        addUncertainty(context, statement, ruleId, "dynamic-command", "command");
      continue;
    }
    for (const reference of taskReferences(invocation))
      evaluateTaskReference(context, statement, reference);
    const ambiguous = ambiguousTaskSubject(invocation);
    if (ambiguous !== null) evaluateAmbiguousTaskReference(context, statement, ambiguous);
    evaluatePackageManager(context, statement, invocation);
    const executablePath = commandPath(invocation);
    if (executablePath !== null) evaluatePath(context, statement, executablePath);
    const tool = commandTool(invocation);
    if (tool !== null) evaluateTool(context, statement, tool);
  }
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const leftKey = `${left.primary.path}\u0000${String(left.primary.range.start.utf16Offset).padStart(16, "0")}\u0000${left.ruleId}\u0000${left.id}`;
  const rightKey = `${right.primary.path}\u0000${String(right.primary.range.start.utf16Offset).padStart(16, "0")}\u0000${right.ruleId}\u0000${right.id}`;
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
}

/** Evaluate ACL300-ACL305 without reading, executing, importing, or contacting the network. */
export function evaluateRepositoryDrift(
  rawStatements: unknown,
  rawEvidenceIndex: unknown,
  rawOptions?: unknown,
): RepositoryDriftResult {
  const limits = validateOptions(rawOptions);
  const statements = validateStatements(rawStatements, limits);
  const index = validateIndex(rawEvidenceIndex, limits);
  const context: EvaluationContext = {
    commandInvocationCount: 0,
    diagnostics: [],
    diagnosticKeys: new Set(),
    factCatalog: buildFactCatalog(index.facts),
    indexUncertain: index.uncertain,
    limits,
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  for (const statement of statements) evaluateStatement(context, statement);
  const diagnostics = Object.freeze([...context.diagnostics].sort(compareDiagnostics));
  const uncertainties = Object.freeze(
    [...context.uncertainties].sort((left, right) => {
      const leftKey = `${left.statementId}\u0000${left.ruleId}\u0000${left.reason}\u0000${left.subject}`;
      const rightKey = `${right.statementId}\u0000${right.ruleId}\u0000${right.reason}\u0000${right.subject}`;
      return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
    }),
  );
  return Object.freeze({
    bundle: Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics,
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze([]),
    }),
    commandLexerContractVersion: COMMAND_LEXER_CONTRACT_VERSION,
    contractVersion: REPOSITORY_DRIFT_CONTRACT_VERSION,
    evidenceIndexContractVersion: EVIDENCE_INDEX_CONTRACT_VERSION,
    limits,
    metrics: Object.freeze({
      commandInvocationCount: context.commandInvocationCount,
      diagnosticCount: diagnostics.length,
      evidenceFactCount: index.facts.length,
      statementCount: statements.length,
      uncertaintyCount: uncertainties.length,
    }),
    statementClassifierContractVersion: STATEMENT_CLASSIFIER_CONTRACT_VERSION,
    uncertainties,
  });
}

/** Type-level marker that this evaluator consumes the exact F01 result contract. */
export type RepositoryDriftEvidenceInput = RepositoryEvidenceIndex;
