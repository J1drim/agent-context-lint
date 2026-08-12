import { types as nodeTypes } from "node:util";

import type {
  AstNodeId,
  InstructionDocumentId,
  InstructionStatement,
  InstructionStatementId,
  SourcePosition,
  SourceRange,
  StatementClassification,
  StatementModality,
  Uncertainty,
} from "@agent-context/core";

export const STATEMENT_CLASSIFIER_CONTRACT_VERSION = "0.1.0" as const;
export const STATEMENT_DOMAINS = [
  "package-manager",
  "command",
  "file-ownership",
  "generated-files",
  "formatting",
  "testing",
  "approval-requirement",
  "path-policy",
] as const;

export type StatementDomain = (typeof STATEMENT_DOMAINS)[number];

export interface StatementClassifierLimits {
  readonly maximumEvidence: number;
  readonly maximumInputLength: number;
  readonly maximumNodeIds: number;
  readonly maximumTokens: number;
}

export type StatementClassifierOptions = Partial<StatementClassifierLimits>;

export const STATEMENT_CLASSIFIER_DEFAULT_LIMITS: Readonly<StatementClassifierLimits> =
  Object.freeze({
    maximumEvidence: 64,
    maximumInputLength: 65_536,
    maximumNodeIds: 4_096,
    maximumTokens: 8_192,
  });

export const STATEMENT_CLASSIFIER_HARD_LIMITS: Readonly<StatementClassifierLimits> = Object.freeze({
  maximumEvidence: 1_024,
  maximumInputLength: 1_048_576,
  maximumNodeIds: 65_536,
  maximumTokens: 131_072,
});

export interface StatementClassifierInput {
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
  /** Exact C08/B03 statement source; it is retained without modification. */
  readonly text: string;
}

export interface NormalizedStatementToken {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

export interface StatementClassifierEvidence {
  readonly confidence: number;
  readonly domain: StatementDomain;
  readonly kind: "compound-template" | "imperative-template" | "modal-template";
  readonly matchedText: string;
  /** Half-open UTF-16 range in normalizedText, not the original source. */
  readonly normalizedEnd: number;
  readonly normalizedStart: number;
  readonly ruleId: string;
}

export interface StatementDomainClassification {
  readonly action: string;
  readonly confidence: number;
  readonly domain: StatementDomain;
  readonly evidence: readonly StatementClassifierEvidence[];
  readonly modality: StatementModality;
  readonly object: string | null;
  readonly subject: string | null;
}

export interface StatementClassifierMetrics {
  readonly domainCount: number;
  readonly evidenceCount: number;
  readonly tokenCount: number;
}

export interface StatementClassifierResult {
  readonly classification: StatementClassification;
  readonly contractVersion: typeof STATEMENT_CLASSIFIER_CONTRACT_VERSION;
  readonly domains: readonly StatementDomainClassification[];
  readonly evidence: readonly StatementClassifierEvidence[];
  readonly limits: StatementClassifierLimits;
  readonly metrics: StatementClassifierMetrics;
  readonly normalizedText: string;
  readonly statement: InstructionStatement;
  readonly tokens: readonly NormalizedStatementToken[];
  readonly uncertainty: Uncertainty;
}

export const StatementClassifierErrorCode: Readonly<{
  invalidInput: "STATEMENT_CLASSIFIER_INVALID_INPUT";
  invalidOptions: "STATEMENT_CLASSIFIER_INVALID_OPTIONS";
  limitExceeded: "STATEMENT_CLASSIFIER_LIMIT_EXCEEDED";
}> = Object.freeze({
  invalidInput: "STATEMENT_CLASSIFIER_INVALID_INPUT",
  invalidOptions: "STATEMENT_CLASSIFIER_INVALID_OPTIONS",
  limitExceeded: "STATEMENT_CLASSIFIER_LIMIT_EXCEEDED",
});

export type StatementClassifierErrorCode =
  (typeof StatementClassifierErrorCode)[keyof typeof StatementClassifierErrorCode];

export class StatementClassifierError extends Error {
  override readonly name = "StatementClassifierError" as const;
  readonly code: StatementClassifierErrorCode;
  readonly limitName: keyof StatementClassifierLimits | null;

  constructor(
    code: StatementClassifierErrorCode,
    message: string,
    limitName: keyof StatementClassifierLimits | null = null,
  ) {
    super(message);
    this.code = code;
    this.limitName = limitName;
    Object.freeze(this);
  }
}

interface Detector {
  readonly action: string;
  readonly confidence: number;
  readonly domain: StatementDomain;
  readonly kind: StatementClassifierEvidence["kind"];
  readonly objectGroup?: number;
  readonly pattern: RegExp;
  readonly ruleId: string;
  readonly subjectGroup?: number;
}

interface ValidatedInput {
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
  readonly text: string;
}

const INPUT_KEYS = new Set(["documentId", "nodeIds", "range", "statementId", "text"]);
const RANGE_KEYS = new Set(["end", "sourceId", "start"]);
const POSITION_KEYS = new Set(["byteOffset", "line", "utf16Column", "utf16Offset"]);
const LIMIT_KEYS = new Set(Object.keys(STATEMENT_CLASSIFIER_DEFAULT_LIMITS));
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_LENGTH = 512;
const TEXT_ENCODER = new TextEncoder();

const DOMAIN_ORDER = new Map(STATEMENT_DOMAINS.map((domain, index) => [domain, index]));

const DETECTORS: readonly Detector[] = Object.freeze([
  {
    action: "select-package-manager",
    confidence: 0.99,
    domain: "package-manager",
    kind: "imperative-template",
    objectGroup: 1,
    pattern: /^(?:must |should |always |do not |never )?use\s+(pnpm|npm|yarn|bun)\b/iu,
    ruleId: "package-manager.use",
  },
  {
    action: "select-package-manager",
    confidence: 0.99,
    domain: "package-manager",
    kind: "compound-template",
    objectGroup: 1,
    pattern:
      /^(?:must |should |always )?(?:install|build|publish)(?:\s+[^.]+?)?\s+(?:with|using)\s+(pnpm|npm|yarn|bun)\b/iu,
    ruleId: "package-manager.workflow",
  },
  {
    action: "select-package-manager",
    confidence: 0.99,
    domain: "package-manager",
    kind: "imperative-template",
    objectGroup: 1,
    pattern: /^(?:must |should |always |do not |never )?(?:run|execute)\s+(pnpm|npm|yarn|bun)\b/iu,
    ruleId: "package-manager.command",
  },
  {
    action: "select-package-manager",
    confidence: 0.99,
    domain: "package-manager",
    kind: "modal-template",
    objectGroup: 1,
    pattern:
      /\b(?:package manager (?:must be|is|required is)|must use|always use|do not use|never use)\s+(pnpm|npm|yarn|bun)\b/iu,
    ruleId: "package-manager.explicit",
  },
  {
    action: "run-command",
    confidence: 0.98,
    domain: "command",
    kind: "imperative-template",
    objectGroup: 1,
    pattern: /^(?:must |should |always |never |do not )?(?:run|execute|invoke)\s+(.+)$/iu,
    ruleId: "command.run",
  },
  {
    action: "assign-owner",
    confidence: 0.99,
    domain: "file-ownership",
    kind: "compound-template",
    objectGroup: 1,
    subjectGroup: 2,
    pattern: /^(.+?)\s+(?:is|are)\s+(?:owned|maintained)\s+by\s+([a-z0-9_.@/-]+)$/iu,
    ruleId: "ownership.passive",
  },
  {
    action: "assign-owner",
    confidence: 0.99,
    domain: "file-ownership",
    kind: "compound-template",
    objectGroup: 2,
    subjectGroup: 1,
    pattern: /^(?!who\b)([a-z0-9_.@/-]+)\s+owns\s+(.+)$/iu,
    ruleId: "ownership.active",
  },
  {
    action: "protect-generated-files",
    confidence: 0.99,
    domain: "generated-files",
    kind: "compound-template",
    objectGroup: 1,
    pattern: /^(?:do not|never|must not)\s+(?:edit|modify|write to|touch)\s+(.*\bgenerated\b.*)$/iu,
    ruleId: "generated.prohibit-edit",
  },
  {
    action: "protect-generated-files",
    confidence: 0.99,
    domain: "generated-files",
    kind: "modal-template",
    objectGroup: 1,
    pattern:
      /^(generated (?:files?|artifacts?)(?:\s+.+?)?)\s+(?:must not be edited|are read-only)$/iu,
    ruleId: "generated.read-only",
  },
  {
    action: "format",
    confidence: 0.98,
    domain: "formatting",
    kind: "compound-template",
    objectGroup: 1,
    pattern:
      /^(?:(?:must |should |always )?format\b.+\b(?:with|using)|formatting\b.+\b(?:must be done with|must use|should use)|the formatter must run with)\s+([a-z0-9_.@/-]+)\b/iu,
    ruleId: "formatting.tool",
  },
  {
    action: "format",
    confidence: 0.98,
    domain: "formatting",
    kind: "modal-template",
    objectGroup: 1,
    pattern:
      /^(?:must |should |always )?(?:use|prefer)\s+(prettier|biome|black|ruff|gofmt|rustfmt)\s+(?:for|to)\s+format/iu,
    ruleId: "formatting.named-tool",
  },
  {
    action: "test",
    confidence: 0.98,
    domain: "testing",
    kind: "compound-template",
    objectGroup: 1,
    pattern: /^(?:must |should |always )?(?:run|execute)\s+(.+?\btests?\b.*)$/iu,
    ruleId: "testing.run",
  },
  {
    action: "test",
    confidence: 0.99,
    domain: "testing",
    kind: "modal-template",
    objectGroup: 1,
    pattern:
      /^(?:(all|unit|integration|end-to-end|e2e)\s+)?tests?\s+(?:must|should)\s+(?:pass|be run)$/iu,
    ruleId: "testing.requirement",
  },
  {
    action: "require-approval",
    confidence: 0.99,
    domain: "approval-requirement",
    kind: "compound-template",
    subjectGroup: 1,
    pattern:
      /^(?:(?:.+?\s+)?requires?|must have|get|obtain)\s+(?:an?\s+)?(?:approval|sign-off)\s+(?:from\s+)?([a-z0-9_.@/-]+)\b/iu,
    ruleId: "approval.require",
  },
  {
    action: "require-approval",
    confidence: 0.99,
    domain: "approval-requirement",
    kind: "compound-template",
    subjectGroup: 1,
    pattern: /^.+\s+requires?\s+([a-z0-9_.@/-]+)\s+(?:approval|sign-off)\b/iu,
    ruleId: "approval.passive-subject",
  },
  {
    action: "require-approval",
    confidence: 0.99,
    domain: "approval-requirement",
    kind: "compound-template",
    subjectGroup: 1,
    pattern:
      /\b(?:do not|never|must not)\s+.+\s+without\s+([a-z0-9_.@/-]+)\s+(?:approval|sign-off)\b/iu,
    ruleId: "approval.without",
  },
  {
    action: "restrict-path",
    confidence: 0.99,
    domain: "path-policy",
    kind: "compound-template",
    objectGroup: 1,
    pattern:
      /^(?:do not|never|must not)\s+(?:edit|modify|write to|touch)\s+((?!.*\bgenerated\b).+)$/iu,
    ruleId: "path.prohibit-write",
  },
  {
    action: "restrict-path",
    confidence: 0.99,
    domain: "path-policy",
    kind: "compound-template",
    objectGroup: 1,
    pattern: /^only\s+(?:edit|modify|write to|touch)\s+(.+)$/iu,
    ruleId: "path.only-write",
  },
  {
    action: "restrict-path",
    confidence: 0.99,
    domain: "path-policy",
    kind: "modal-template",
    objectGroup: 1,
    pattern: /^(?:allowed|forbidden)\s+paths?\s*:\s*(.+)$/iu,
    ruleId: "path.explicit-list",
  },
]);

function invalidInput(message: string): never {
  throw new StatementClassifierError(StatementClassifierErrorCode.invalidInput, message);
}

function dataRecord(
  value: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return invalidInput(`${name} must be a non-proxy plain object`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalidInput(`${name} must have a plain prototype`);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidInput(`${name} properties could not be inspected safely`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key))
      return invalidInput(`${name} contains an unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      return invalidInput(`${name} must contain only own data properties`);
    output[key] = descriptor.value;
  }
  return output;
}

function stableIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !STABLE_IDENTIFIER.test(value)
  )
    return invalidInput(`${name} must be a bounded stable identifier`);
  return value;
}

function natural(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    return invalidInput(`${name} must be a non-negative safe integer`);
  return value as number;
}

function position(value: unknown, name: string): SourcePosition {
  const item = dataRecord(value, name, POSITION_KEYS);
  return Object.freeze({
    byteOffset: natural(item["byteOffset"], `${name}.byteOffset`),
    line: natural(item["line"], `${name}.line`),
    utf16Column: natural(item["utf16Column"], `${name}.utf16Column`),
    utf16Offset: natural(item["utf16Offset"], `${name}.utf16Offset`),
  });
}

function sourceRange(value: unknown): SourceRange {
  const item = dataRecord(value, "input.range", RANGE_KEYS);
  const start = position(item["start"], "input.range.start");
  const end = position(item["end"], "input.range.end");
  if (
    end.byteOffset < start.byteOffset ||
    end.utf16Offset < start.utf16Offset ||
    end.line < start.line ||
    (end.line === start.line && end.utf16Column < start.utf16Column)
  )
    return invalidInput("input.range must not be reversed");
  return Object.freeze({
    end,
    sourceId: stableIdentifier(item["sourceId"], "input.range.sourceId") as SourceRange["sourceId"],
    start,
  });
}

function denseIdentifiers(value: unknown, limit: number): readonly AstNodeId[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value))
    return invalidInput("input.nodeIds must be a non-proxy array");
  if (value.length === 0) return invalidInput("input.nodeIds must not be empty");
  if (value.length > limit)
    throw new StatementClassifierError(
      StatementClassifierErrorCode.limitExceeded,
      "maximumNodeIds was exceeded",
      "maximumNodeIds",
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
    return invalidInput("input.nodeIds must not contain extra properties");
  const result: AstNodeId[] = [];
  let previous = "";
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return invalidInput("input.nodeIds must be dense");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor))
      return invalidInput("input.nodeIds must contain only own data properties");
    const current = stableIdentifier(descriptor.value, `input.nodeIds[${String(index)}]`);
    if (current <= previous) return invalidInput("input.nodeIds must be sorted and unique");
    previous = current;
    result.push(current as AstNodeId);
  }
  return Object.freeze(result);
}

function validateLimit(value: unknown, name: keyof StatementClassifierLimits): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > STATEMENT_CLASSIFIER_HARD_LIMITS[name]
  )
    throw new StatementClassifierError(
      StatementClassifierErrorCode.invalidOptions,
      `${name} must be a positive safe integer no greater than ${String(STATEMENT_CLASSIFIER_HARD_LIMITS[name])}`,
      name,
    );
  return value as number;
}

function validateOptions(value: unknown): StatementClassifierLimits {
  if (value === undefined) return STATEMENT_CLASSIFIER_DEFAULT_LIMITS;
  let options: Record<string, unknown>;
  try {
    options = dataRecord(value, "options", LIMIT_KEYS);
  } catch (error) {
    if (error instanceof StatementClassifierError)
      throw new StatementClassifierError(
        StatementClassifierErrorCode.invalidOptions,
        error.message,
      );
    throw error;
  }
  const limits: Record<string, number> = {};
  for (const key of LIMIT_KEYS as ReadonlySet<keyof StatementClassifierLimits>)
    limits[key] = validateLimit(
      Object.hasOwn(options, key) ? options[key] : STATEMENT_CLASSIFIER_DEFAULT_LIMITS[key],
      key,
    );
  return Object.freeze(limits) as unknown as StatementClassifierLimits;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateInput(value: unknown, limits: StatementClassifierLimits): ValidatedInput {
  const item = dataRecord(value, "input", INPUT_KEYS);
  if (typeof item["text"] !== "string") return invalidInput("input.text must be a string");
  if (!isWellFormedText(item["text"]))
    return invalidInput("input.text must contain well-formed Unicode");
  if (item["text"].length > limits.maximumInputLength)
    throw new StatementClassifierError(
      StatementClassifierErrorCode.limitExceeded,
      "maximumInputLength was exceeded",
      "maximumInputLength",
    );
  const range = sourceRange(item["range"]);
  if (range.end.utf16Offset - range.start.utf16Offset !== item["text"].length)
    return invalidInput("input.range UTF-16 span must equal input.text length");
  if (range.end.byteOffset - range.start.byteOffset !== TEXT_ENCODER.encode(item["text"]).length)
    return invalidInput("input.range byte span must equal input.text UTF-8 length");
  let lineBreaks = 0;
  let lastLineStart = 0;
  for (let index = 0; index < item["text"].length; index += 1) {
    const unit = item["text"].charCodeAt(index);
    if (unit === 0x0a || (unit === 0x0d && item["text"].charCodeAt(index + 1) !== 0x0a)) {
      lineBreaks += 1;
      lastLineStart = index + 1;
    }
  }
  const expectedEndLine = range.start.line + lineBreaks;
  const expectedEndColumn =
    lineBreaks === 0
      ? range.start.utf16Column + item["text"].length
      : item["text"].length - lastLineStart;
  if (range.end.line !== expectedEndLine || range.end.utf16Column !== expectedEndColumn)
    return invalidInput("input.range line and column span must match input.text");
  return Object.freeze({
    documentId: stableIdentifier(item["documentId"], "input.documentId") as InstructionDocumentId,
    nodeIds: denseIdentifiers(item["nodeIds"], limits.maximumNodeIds),
    range,
    statementId: stableIdentifier(
      item["statementId"],
      "input.statementId",
    ) as InstructionStatementId,
    text: item["text"],
  });
}

function normalizeMarkdownText(text: string): string {
  let normalized = text.normalize("NFC").replace(/\r\n?|\n/gu, "\n");
  normalized = normalized
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:>\s*)+/u, "")
        .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, ""),
    )
    .join(" ");
  normalized = normalized.replace(/\[([^\]\r\n]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/gu, "$1");
  normalized = normalized.replace(/`([^`\r\n]+)`/gu, "$1");
  normalized = normalized.replace(
    /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu,
    " ",
  );
  normalized = normalized
    .trim()
    .replace(/[.!?;:]+$/u, "")
    .toLowerCase();
  return normalized;
}

function tokenize(
  normalizedText: string,
  maximumTokens: number,
): readonly NormalizedStatementToken[] {
  const tokens: NormalizedStatementToken[] = [];
  const pattern = /[^\s]+/gu;
  for (const match of normalizedText.matchAll(pattern)) {
    if (tokens.length >= maximumTokens)
      throw new StatementClassifierError(
        StatementClassifierErrorCode.limitExceeded,
        "maximumTokens was exceeded",
        "maximumTokens",
      );
    const start = match.index;
    tokens.push(Object.freeze({ end: start + match[0].length, start, text: match[0] }));
  }
  return Object.freeze(tokens);
}

function modalityOf(text: string): StatementModality {
  if (/\b(?:must not|do not|never|prohibited|forbidden)\b/iu.test(text)) return "must-not";
  if (/\b(?:must|required|always)\b/iu.test(text)) return "must";
  if (/\bshould\b/iu.test(text)) return "should";
  if (/\bprefer(?:red|ence)?\b/iu.test(text)) return "preference";
  return /^(?:run|execute|invoke|use|only|format|get|obtain)\b/iu.test(text)
    ? "must"
    : "information";
}

function matchEvidence(
  detector: Detector,
  normalizedText: string,
): { evidence: StatementClassifierEvidence; match: RegExpExecArray } | null {
  detector.pattern.lastIndex = 0;
  const match = detector.pattern.exec(normalizedText);
  if (match === null) return null;
  return {
    evidence: Object.freeze({
      confidence: detector.confidence,
      domain: detector.domain,
      kind: detector.kind,
      matchedText: match[0],
      normalizedEnd: match.index + match[0].length,
      normalizedStart: match.index,
      ruleId: detector.ruleId,
    }),
    match,
  };
}

function classifyDomains(
  normalizedText: string,
  maximumEvidence: number,
): readonly StatementDomainClassification[] {
  const modality = modalityOf(normalizedText);
  const grouped = new Map<
    StatementDomain,
    { detector: Detector; evidence: StatementClassifierEvidence[]; match: RegExpExecArray }
  >();
  for (const detector of DETECTORS) {
    const result = matchEvidence(detector, normalizedText);
    if (result === null) continue;
    const existing = grouped.get(detector.domain);
    if (existing === undefined)
      grouped.set(detector.domain, { detector, evidence: [result.evidence], match: result.match });
    else existing.evidence.push(result.evidence);
    const evidenceCount = [...grouped.values()].reduce(
      (sum, entry) => sum + entry.evidence.length,
      0,
    );
    if (evidenceCount > maximumEvidence)
      throw new StatementClassifierError(
        StatementClassifierErrorCode.limitExceeded,
        "maximumEvidence was exceeded",
        "maximumEvidence",
      );
  }
  return Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => (DOMAIN_ORDER.get(left) ?? 0) - (DOMAIN_ORDER.get(right) ?? 0))
      .map(([domain, entry]) => {
        const object =
          entry.detector.objectGroup === undefined
            ? null
            : (entry.match[entry.detector.objectGroup]?.trim() ?? null);
        const subject =
          entry.detector.subjectGroup === undefined
            ? null
            : (entry.match[entry.detector.subjectGroup]?.trim() ?? null);
        return Object.freeze({
          action: entry.detector.action,
          confidence: Math.max(...entry.evidence.map((item) => item.confidence)),
          domain,
          evidence: Object.freeze(entry.evidence),
          modality,
          object,
          subject,
        });
      }),
  );
}

function projectClassification(
  normalizedText: string,
  domains: readonly StatementDomainClassification[],
): StatementClassification {
  const primary = domains[0];
  if (primary === undefined) return Object.freeze({ state: "unclassified" });
  return Object.freeze({
    action: primary.action,
    categoryId: primary.domain,
    confidence: primary.confidence,
    modality: primary.modality,
    normalizedText,
    object: primary.object,
    state: "classified",
    subject: primary.subject,
  });
}

/** Deterministically normalize and classify inert C08/B03 statement text. */
export function normalizeAndClassifyStatement(
  rawInput: unknown,
  rawOptions?: unknown,
): StatementClassifierResult {
  const limits = validateOptions(rawOptions);
  const input = validateInput(rawInput, limits);
  const normalizedText = normalizeMarkdownText(input.text);
  const tokens = tokenize(normalizedText, limits.maximumTokens);
  const domains = classifyDomains(normalizedText, limits.maximumEvidence);
  const classification = projectClassification(normalizedText, domains);
  const evidence = Object.freeze(domains.flatMap((domain) => domain.evidence));
  const statement: InstructionStatement = Object.freeze({
    classification,
    documentId: input.documentId,
    id: input.statementId,
    nodeIds: input.nodeIds,
    range: input.range,
    text: input.text,
  });
  return Object.freeze({
    classification,
    contractVersion: STATEMENT_CLASSIFIER_CONTRACT_VERSION,
    domains,
    evidence,
    limits,
    metrics: Object.freeze({
      domainCount: domains.length,
      evidenceCount: evidence.length,
      tokenCount: tokens.length,
    }),
    normalizedText,
    statement,
    tokens,
    uncertainty:
      domains.length === 0
        ? Object.freeze({
            reason: "no high-confidence deterministic domain template matched",
            state: "unknown",
          })
        : Object.freeze({ state: "known" }),
  });
}
