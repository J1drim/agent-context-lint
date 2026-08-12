import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  AstNodeId,
  InstructionDocumentId,
  InstructionStatementId,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";

import { STATEMENT_CLASSIFIER_CONTRACT_VERSION } from "./statement-classifier.js";

export const DUPLICATION_INDEX_CONTRACT_VERSION = "0.1.0" as const;
export const DUPLICATION_SIMILARITY_ALGORITHM = "unicode-code-point-trigram-jaccard-v1" as const;

export interface DuplicationIndexEntry {
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  /** Exact F03 normalized text, not original Markdown. */
  readonly normalizedText: string;
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
}

export interface DuplicationIndexLimits {
  readonly maximumAnchorsPerEntry: number;
  readonly maximumCandidateComparisons: number;
  readonly maximumClusterMembers: number;
  readonly maximumEntries: number;
  readonly maximumNodeIdsPerEntry: number;
  readonly maximumNormalizedTextLength: number;
  readonly maximumPostingLength: number;
  readonly maximumShinglesPerEntry: number;
  readonly maximumTotalNormalizedTextLength: number;
  readonly maximumTotalShingleOccurrences: number;
  readonly minimumNearDuplicateCodePoints: number;
  readonly minimumSimilarityBasisPoints: number;
}

export type DuplicationIndexOptions = Partial<DuplicationIndexLimits>;

export const DUPLICATION_INDEX_DEFAULT_LIMITS: Readonly<DuplicationIndexLimits> = Object.freeze({
  maximumAnchorsPerEntry: 16,
  maximumCandidateComparisons: 2_000_000,
  maximumClusterMembers: 100_000,
  maximumEntries: 100_000,
  maximumNodeIdsPerEntry: 4_096,
  maximumNormalizedTextLength: 65_536,
  maximumPostingLength: 1_024,
  maximumShinglesPerEntry: 4_096,
  maximumTotalNormalizedTextLength: 67_108_864,
  maximumTotalShingleOccurrences: 2_000_000,
  minimumNearDuplicateCodePoints: 12,
  minimumSimilarityBasisPoints: 8_000,
});

export const DUPLICATION_INDEX_HARD_LIMITS: Readonly<DuplicationIndexLimits> = Object.freeze({
  maximumAnchorsPerEntry: 128,
  maximumCandidateComparisons: 20_000_000,
  maximumClusterMembers: 1_000_000,
  maximumEntries: 1_000_000,
  maximumNodeIdsPerEntry: 65_536,
  maximumNormalizedTextLength: 1_048_576,
  maximumPostingLength: 65_536,
  maximumShinglesPerEntry: 65_536,
  maximumTotalNormalizedTextLength: 536_870_912,
  maximumTotalShingleOccurrences: 20_000_000,
  minimumNearDuplicateCodePoints: 1_024,
  minimumSimilarityBasisPoints: 10_000,
});

export interface DuplicationEvidencePointer {
  readonly documentId: InstructionDocumentId;
  readonly nodeIds: readonly AstNodeId[];
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
}

export interface ExactDuplicationCluster {
  readonly id: string;
  readonly kind: "exact";
  readonly members: readonly DuplicationEvidencePointer[];
  readonly normalizedTextSha256: string;
  readonly similarityBasisPoints: 10_000;
}

export interface NearDuplicationEdge {
  readonly intersectionShingles: number;
  readonly leftStatementId: InstructionStatementId;
  readonly rightStatementId: InstructionStatementId;
  readonly similarityBasisPoints: number;
  readonly unionShingles: number;
}

export interface NearDuplicationCluster {
  readonly edges: readonly NearDuplicationEdge[];
  readonly id: string;
  readonly kind: "near";
  readonly members: readonly DuplicationEvidencePointer[];
}

export interface DuplicationIndexExclusion {
  readonly evidence: DuplicationEvidencePointer;
  readonly reason: "empty-normalized-text" | "near-text-too-short";
}

export interface DuplicationIndexMetrics {
  readonly candidateComparisons: number;
  readonly entryCount: number;
  readonly exactClusterCount: number;
  readonly exactDuplicateEntryCount: number;
  readonly nearClusterCount: number;
  readonly nearEdgeCount: number;
  readonly totalNormalizedTextLength: number;
  readonly totalShingleOccurrences: number;
  readonly uniqueNormalizedTextCount: number;
}

export interface DuplicationSimilarityContract {
  readonly algorithm: typeof DUPLICATION_SIMILARITY_ALGORITHM;
  readonly candidateStrategy: "globally-rarest-bounded-shingles";
  readonly measure: "set-jaccard";
  readonly minimumSimilarityBasisPoints: number;
  readonly normalizationContractVersion: typeof STATEMENT_CLASSIFIER_CONTRACT_VERSION;
  readonly shingleUnit: "unicode-code-point";
  readonly shingleWidth: 3;
}

export interface DuplicationIndexResult {
  readonly contractVersion: typeof DUPLICATION_INDEX_CONTRACT_VERSION;
  readonly exactClusters: readonly ExactDuplicationCluster[];
  readonly exclusions: readonly DuplicationIndexExclusion[];
  readonly limits: DuplicationIndexLimits;
  readonly metrics: DuplicationIndexMetrics;
  readonly nearClusters: readonly NearDuplicationCluster[];
  readonly similarity: DuplicationSimilarityContract;
}

export const DuplicationIndexErrorCode: Readonly<{
  invalidInput: "DUPLICATION_INDEX_INVALID_INPUT";
  invalidOptions: "DUPLICATION_INDEX_INVALID_OPTIONS";
  limitExceeded: "DUPLICATION_INDEX_LIMIT_EXCEEDED";
}> = Object.freeze({
  invalidInput: "DUPLICATION_INDEX_INVALID_INPUT",
  invalidOptions: "DUPLICATION_INDEX_INVALID_OPTIONS",
  limitExceeded: "DUPLICATION_INDEX_LIMIT_EXCEEDED",
});

export type DuplicationIndexErrorCode =
  (typeof DuplicationIndexErrorCode)[keyof typeof DuplicationIndexErrorCode];

export class DuplicationIndexError extends Error {
  override readonly name = "DuplicationIndexError" as const;
  readonly code: DuplicationIndexErrorCode;
  readonly limitName: keyof DuplicationIndexLimits | null;

  constructor(
    code: DuplicationIndexErrorCode,
    message: string,
    limitName: keyof DuplicationIndexLimits | null = null,
  ) {
    super(message);
    this.code = code;
    this.limitName = limitName;
    Object.freeze(this);
  }
}

interface UniqueTextRecord {
  readonly members: readonly ValidatedEntry[];
  readonly normalizedText: string;
  readonly shingles: readonly string[];
}

type ValidatedEntry = DuplicationIndexEntry;

interface MutableMetrics {
  candidateComparisons: number;
  totalNormalizedTextLength: number;
  totalShingleOccurrences: number;
}

const ENTRY_KEYS = new Set(["documentId", "nodeIds", "normalizedText", "range", "statementId"]);
const RANGE_KEYS = new Set(["end", "sourceId", "start"]);
const POSITION_KEYS = new Set(["byteOffset", "line", "utf16Column", "utf16Offset"]);
const LIMIT_KEYS = new Set(Object.keys(DUPLICATION_INDEX_DEFAULT_LIMITS));
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_LENGTH = 512;
const SHINGLE_WIDTH = 3;
const START_SENTINEL = "\u0002";
const END_SENTINEL = "\u0003";

function invalidInput(message: string): never {
  throw new DuplicationIndexError(DuplicationIndexErrorCode.invalidInput, message);
}

function record(
  value: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
  errorCode: DuplicationIndexErrorCode = DuplicationIndexErrorCode.invalidInput,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    throw new DuplicationIndexError(errorCode, `${name} must be a non-proxy plain object`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new DuplicationIndexError(errorCode, `${name} must have a plain prototype`);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new DuplicationIndexError(errorCode, `${name} properties could not be inspected safely`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key))
      throw new DuplicationIndexError(errorCode, `${name} contains an unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      throw new DuplicationIndexError(errorCode, `${name} must contain only own data properties`);
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
  const item = record(value, name, POSITION_KEYS);
  return Object.freeze({
    byteOffset: natural(item["byteOffset"], `${name}.byteOffset`),
    line: natural(item["line"], `${name}.line`),
    utf16Column: natural(item["utf16Column"], `${name}.utf16Column`),
    utf16Offset: natural(item["utf16Offset"], `${name}.utf16Offset`),
  });
}

function sourceRange(value: unknown, name: string): SourceRange {
  const item = record(value, `${name}.range`, RANGE_KEYS);
  const start = position(item["start"], `${name}.range.start`);
  const end = position(item["end"], `${name}.range.end`);
  if (
    end.byteOffset < start.byteOffset ||
    end.utf16Offset < start.utf16Offset ||
    end.line < start.line ||
    (end.line === start.line && end.utf16Column < start.utf16Column)
  )
    return invalidInput(`${name}.range must not be reversed`);
  return Object.freeze({
    end,
    sourceId: stableIdentifier(item["sourceId"], `${name}.range.sourceId`) as SourceDocumentId,
    start,
  });
}

function denseNodeIds(
  value: unknown,
  name: string,
  maximumNodeIdsPerEntry: number,
): readonly AstNodeId[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value))
    return invalidInput(`${name}.nodeIds must be a non-proxy array`);
  if (value.length === 0) return invalidInput(`${name}.nodeIds must not be empty`);
  if (value.length > maximumNodeIdsPerEntry)
    throw new DuplicationIndexError(
      DuplicationIndexErrorCode.limitExceeded,
      "maximumNodeIdsPerEntry was exceeded",
      "maximumNodeIdsPerEntry",
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
    return invalidInput(`${name}.nodeIds must be dense and contain no extra properties`);
  const output: AstNodeId[] = [];
  let previous = "";
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor))
      return invalidInput(`${name}.nodeIds must contain only own data properties`);
    const current = stableIdentifier(descriptor.value, `${name}.nodeIds[${String(index)}]`);
    if (current <= previous) return invalidInput(`${name}.nodeIds must be sorted and unique`);
    previous = current;
    output.push(current as AstNodeId);
  }
  return Object.freeze(output);
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

function normalizedText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string") return invalidInput(`${name}.normalizedText must be a string`);
  if (value.length > maximumLength)
    throw new DuplicationIndexError(
      DuplicationIndexErrorCode.limitExceeded,
      "maximumNormalizedTextLength was exceeded",
      "maximumNormalizedTextLength",
    );
  if (!isWellFormedText(value))
    return invalidInput(`${name}.normalizedText must contain well-formed Unicode`);
  if (
    value !== value.normalize("NFC") ||
    value !== value.toLowerCase() ||
    value !== value.trim() ||
    /[\t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]| {2}/u.test(value)
  )
    return invalidInput(`${name}.normalizedText must be canonical F03 normalized text`);
  return value;
}

function validateLimit(value: unknown, name: keyof DuplicationIndexLimits): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > DUPLICATION_INDEX_HARD_LIMITS[name]
  )
    throw new DuplicationIndexError(
      DuplicationIndexErrorCode.invalidOptions,
      `${name} must be a positive safe integer no greater than ${String(DUPLICATION_INDEX_HARD_LIMITS[name])}`,
      name,
    );
  return value as number;
}

function validateOptions(value: unknown): DuplicationIndexLimits {
  if (value === undefined) return DUPLICATION_INDEX_DEFAULT_LIMITS;
  const options = record(value, "options", LIMIT_KEYS, DuplicationIndexErrorCode.invalidOptions);
  const output: Record<string, number> = {};
  for (const key of LIMIT_KEYS as ReadonlySet<keyof DuplicationIndexLimits>)
    output[key] = validateLimit(
      Object.hasOwn(options, key) ? options[key] : DUPLICATION_INDEX_DEFAULT_LIMITS[key],
      key,
    );
  return Object.freeze(output) as unknown as DuplicationIndexLimits;
}

function validateEntries(
  value: unknown,
  limits: DuplicationIndexLimits,
  metrics: MutableMetrics,
): readonly ValidatedEntry[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value))
    return invalidInput("entries must be a non-proxy array");
  if (value.length > limits.maximumEntries)
    throw new DuplicationIndexError(
      DuplicationIndexErrorCode.limitExceeded,
      "maximumEntries was exceeded",
      "maximumEntries",
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
    return invalidInput("entries must be dense and contain no extra properties");
  const output: ValidatedEntry[] = [];
  let previousStatementId = "";
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor))
      return invalidInput("entries must contain only own data properties");
    const name = `entries[${String(index)}]`;
    const item = record(descriptor.value, name, ENTRY_KEYS);
    const statementId = stableIdentifier(item["statementId"], `${name}.statementId`);
    if (statementId <= previousStatementId)
      return invalidInput("entries must be sorted by unique statementId");
    previousStatementId = statementId;
    const text = normalizedText(item["normalizedText"], name, limits.maximumNormalizedTextLength);
    metrics.totalNormalizedTextLength += text.length;
    if (metrics.totalNormalizedTextLength > limits.maximumTotalNormalizedTextLength)
      throw new DuplicationIndexError(
        DuplicationIndexErrorCode.limitExceeded,
        "maximumTotalNormalizedTextLength was exceeded",
        "maximumTotalNormalizedTextLength",
      );
    output.push(
      Object.freeze({
        documentId: stableIdentifier(
          item["documentId"],
          `${name}.documentId`,
        ) as InstructionDocumentId,
        nodeIds: denseNodeIds(item["nodeIds"], name, limits.maximumNodeIdsPerEntry),
        normalizedText: text,
        range: sourceRange(item["range"], name),
        statementId: statementId as InstructionStatementId,
      }),
    );
  }
  return Object.freeze(output);
}

function evidence(entry: ValidatedEntry): DuplicationEvidencePointer {
  return Object.freeze({
    documentId: entry.documentId,
    nodeIds: entry.nodeIds,
    range: entry.range,
    statementId: entry.statementId,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableClusterId(kind: "exact" | "near", statementIds: readonly string[]): string {
  return `duplicate-${kind}-${sha256(JSON.stringify(statementIds)).slice(0, 20)}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(
  left: DuplicationEvidencePointer,
  right: DuplicationEvidencePointer,
): number {
  return compareStrings(left.statementId, right.statementId);
}

function createShingles(text: string, limits: DuplicationIndexLimits): readonly string[] {
  const symbols = [START_SENTINEL, ...Array.from(text), END_SENTINEL];
  const shingles = new Set<string>();
  for (let index = 0; index + SHINGLE_WIDTH <= symbols.length; index += 1)
    shingles.add(symbols.slice(index, index + SHINGLE_WIDTH).join(""));
  if (shingles.size > limits.maximumShinglesPerEntry)
    throw new DuplicationIndexError(
      DuplicationIndexErrorCode.limitExceeded,
      "maximumShinglesPerEntry was exceeded",
      "maximumShinglesPerEntry",
    );
  return Object.freeze([...shingles].sort());
}

function buildUniqueRecords(
  entries: readonly ValidatedEntry[],
  limits: DuplicationIndexLimits,
  metrics: MutableMetrics,
): readonly UniqueTextRecord[] {
  const grouped = new Map<string, ValidatedEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.normalizedText);
    if (current === undefined) grouped.set(entry.normalizedText, [entry]);
    else current.push(entry);
  }
  const records: UniqueTextRecord[] = [];
  for (const [text, members] of [...grouped.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    const shingles = createShingles(text, limits);
    metrics.totalShingleOccurrences += shingles.length;
    if (metrics.totalShingleOccurrences > limits.maximumTotalShingleOccurrences)
      throw new DuplicationIndexError(
        DuplicationIndexErrorCode.limitExceeded,
        "maximumTotalShingleOccurrences was exceeded",
        "maximumTotalShingleOccurrences",
      );
    records.push(
      Object.freeze({
        members: Object.freeze(
          [...members].sort((left, right) => compareStrings(left.statementId, right.statementId)),
        ),
        normalizedText: text,
        shingles,
      }),
    );
  }
  return Object.freeze(records);
}

function exactClusters(
  records: readonly UniqueTextRecord[],
  limits: DuplicationIndexLimits,
): readonly ExactDuplicationCluster[] {
  const clusters = records
    .filter(
      (recordValue) => recordValue.normalizedText.length > 0 && recordValue.members.length > 1,
    )
    .map((recordValue) => {
      const members = Object.freeze(recordValue.members.map(evidence).sort(compareEvidence));
      if (members.length > limits.maximumClusterMembers)
        throw new DuplicationIndexError(
          DuplicationIndexErrorCode.limitExceeded,
          "maximumClusterMembers was exceeded",
          "maximumClusterMembers",
        );
      return Object.freeze({
        id: stableClusterId(
          "exact",
          members.map((member) => member.statementId),
        ),
        kind: "exact" as const,
        members,
        normalizedTextSha256: sha256(recordValue.normalizedText),
        similarityBasisPoints: 10_000 as const,
      });
    });
  return Object.freeze(clusters.sort((left, right) => compareStrings(left.id, right.id)));
}

function jaccard(
  left: readonly string[],
  right: readonly string[],
): { intersection: number; similarityBasisPoints: number; union: number } {
  const rightSet = new Set(right);
  let intersection = 0;
  for (const shingle of left) if (rightSet.has(shingle)) intersection += 1;
  const union = left.length + right.length - intersection;
  return {
    intersection,
    similarityBasisPoints: union === 0 ? 10_000 : Math.floor((intersection * 10_000) / union),
    union,
  };
}

function selectedAnchors(
  recordValue: UniqueTextRecord,
  support: ReadonlyMap<string, number>,
  limits: DuplicationIndexLimits,
): readonly string[] {
  return recordValue.shingles
    .filter((shingle) => {
      const count = support.get(shingle) ?? 0;
      return count >= 2 && count <= limits.maximumPostingLength;
    })
    .sort((left, right) => {
      const supportDifference = (support.get(left) ?? 0) - (support.get(right) ?? 0);
      return supportDifference === 0 ? compareStrings(left, right) : supportDifference;
    })
    .slice(0, limits.maximumAnchorsPerEntry);
}

function primaryStatementId(recordValue: UniqueTextRecord): InstructionStatementId {
  const first = recordValue.members[0];
  if (first === undefined) throw new Error("internal unique text record had no members");
  return first.statementId;
}

function nearEdges(
  records: readonly UniqueTextRecord[],
  limits: DuplicationIndexLimits,
  metrics: MutableMetrics,
): readonly {
  readonly left: number;
  readonly right: number;
  readonly value: NearDuplicationEdge;
}[] {
  const eligible = records.map(
    (recordValue) =>
      Array.from(recordValue.normalizedText).length >= limits.minimumNearDuplicateCodePoints,
  );
  const support = new Map<string, number>();
  for (const [index, recordValue] of records.entries()) {
    if (!eligible[index]) continue;
    for (const shingle of recordValue.shingles)
      support.set(shingle, (support.get(shingle) ?? 0) + 1);
  }
  const postings = new Map<string, number[]>();
  const output: { left: number; right: number; value: NearDuplicationEdge }[] = [];
  for (const [right, recordValue] of records.entries()) {
    if (!eligible[right]) continue;
    const anchors = selectedAnchors(recordValue, support, limits);
    const candidates = new Set<number>();
    for (const anchor of anchors)
      for (const left of postings.get(anchor) ?? []) candidates.add(left);
    for (const left of [...candidates].sort((a, b) => a - b)) {
      metrics.candidateComparisons += 1;
      if (metrics.candidateComparisons > limits.maximumCandidateComparisons)
        throw new DuplicationIndexError(
          DuplicationIndexErrorCode.limitExceeded,
          "maximumCandidateComparisons was exceeded",
          "maximumCandidateComparisons",
        );
      const leftRecord = records[left];
      if (leftRecord === undefined) throw new Error("internal duplicate candidate was unavailable");
      const similarity = jaccard(leftRecord.shingles, recordValue.shingles);
      if (similarity.similarityBasisPoints < limits.minimumSimilarityBasisPoints) continue;
      output.push({
        left,
        right,
        value: Object.freeze({
          intersectionShingles: similarity.intersection,
          leftStatementId: primaryStatementId(leftRecord),
          rightStatementId: primaryStatementId(recordValue),
          similarityBasisPoints: similarity.similarityBasisPoints,
          unionShingles: similarity.union,
        }),
      });
    }
    for (const anchor of anchors) {
      const posting = postings.get(anchor);
      if (posting === undefined) postings.set(anchor, [right]);
      else posting.push(right);
    }
  }
  return Object.freeze(output);
}

function find(parent: Int32Array, value: number): number {
  let current = value;
  while (parent[current] !== current) current = parent[current] ?? current;
  let next = value;
  while (parent[next] !== current) {
    const following = parent[next];
    parent[next] = current;
    if (following === undefined) break;
    next = following;
  }
  return current;
}

function union(parent: Int32Array, left: number, right: number): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
  else parent[leftRoot] = rightRoot;
}

function nearClusters(
  records: readonly UniqueTextRecord[],
  edges: readonly {
    readonly left: number;
    readonly right: number;
    readonly value: NearDuplicationEdge;
  }[],
  limits: DuplicationIndexLimits,
): readonly NearDuplicationCluster[] {
  const parent = new Int32Array(records.length);
  for (let index = 0; index < parent.length; index += 1) parent[index] = index;
  for (const edge of edges) union(parent, edge.left, edge.right);
  const components = new Map<number, Set<number>>();
  for (const edge of edges) {
    const root = find(parent, edge.left);
    const component = components.get(root);
    if (component === undefined) components.set(root, new Set([edge.left, edge.right]));
    else component.add(edge.left).add(edge.right);
  }
  const output: NearDuplicationCluster[] = [];
  for (const component of components.values()) {
    const indices = [...component].sort((left, right) => left - right);
    const members = Object.freeze(
      indices
        .flatMap((index) => records[index]?.members ?? [])
        .map(evidence)
        .sort(compareEvidence),
    );
    if (members.length > limits.maximumClusterMembers)
      throw new DuplicationIndexError(
        DuplicationIndexErrorCode.limitExceeded,
        "maximumClusterMembers was exceeded",
        "maximumClusterMembers",
      );
    const indexSet = new Set(indices);
    const componentEdges = Object.freeze(
      edges
        .filter((edge) => indexSet.has(edge.left) && indexSet.has(edge.right))
        .map((edge) => edge.value)
        .sort((left, right) =>
          left.leftStatementId === right.leftStatementId
            ? compareStrings(left.rightStatementId, right.rightStatementId)
            : compareStrings(left.leftStatementId, right.leftStatementId),
        ),
    );
    output.push(
      Object.freeze({
        edges: componentEdges,
        id: stableClusterId(
          "near",
          members.map((member) => member.statementId),
        ),
        kind: "near",
        members,
      }),
    );
  }
  return Object.freeze(output.sort((left, right) => compareStrings(left.id, right.id)));
}

function exclusions(
  entries: readonly ValidatedEntry[],
  limits: DuplicationIndexLimits,
): readonly DuplicationIndexExclusion[] {
  return Object.freeze(
    entries
      .filter(
        (entry) =>
          entry.normalizedText.length === 0 ||
          Array.from(entry.normalizedText).length < limits.minimumNearDuplicateCodePoints,
      )
      .map((entry) =>
        Object.freeze({
          evidence: evidence(entry),
          reason:
            entry.normalizedText.length === 0
              ? ("empty-normalized-text" as const)
              : ("near-text-too-short" as const),
        }),
      ),
  );
}

/** Build deterministic exact and bounded near-duplicate clusters over F03 normalized statements. */
export function buildDuplicationIndex(
  rawEntries: unknown,
  rawOptions?: unknown,
): DuplicationIndexResult {
  const limits = validateOptions(rawOptions);
  const mutableMetrics: MutableMetrics = {
    candidateComparisons: 0,
    totalNormalizedTextLength: 0,
    totalShingleOccurrences: 0,
  };
  const entries = validateEntries(rawEntries, limits, mutableMetrics);
  const records = buildUniqueRecords(entries, limits, mutableMetrics);
  const exact = exactClusters(records, limits);
  const edges = nearEdges(records, limits, mutableMetrics);
  const near = nearClusters(records, edges, limits);
  return Object.freeze({
    contractVersion: DUPLICATION_INDEX_CONTRACT_VERSION,
    exactClusters: exact,
    exclusions: exclusions(entries, limits),
    limits,
    metrics: Object.freeze({
      candidateComparisons: mutableMetrics.candidateComparisons,
      entryCount: entries.length,
      exactClusterCount: exact.length,
      exactDuplicateEntryCount: exact.reduce((sum, cluster) => sum + cluster.members.length, 0),
      nearClusterCount: near.length,
      nearEdgeCount: edges.length,
      totalNormalizedTextLength: mutableMetrics.totalNormalizedTextLength,
      totalShingleOccurrences: mutableMetrics.totalShingleOccurrences,
      uniqueNormalizedTextCount: records.length,
    }),
    nearClusters: near,
    similarity: Object.freeze({
      algorithm: DUPLICATION_SIMILARITY_ALGORITHM,
      candidateStrategy: "globally-rarest-bounded-shingles",
      measure: "set-jaccard",
      minimumSimilarityBasisPoints: limits.minimumSimilarityBasisPoints,
      normalizationContractVersion: STATEMENT_CLASSIFIER_CONTRACT_VERSION,
      shingleUnit: "unicode-code-point",
      shingleWidth: 3,
    }),
  });
}
