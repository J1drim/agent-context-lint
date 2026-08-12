import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath } from "@agent-context/core";
import type { DocumentImportDag, ImportDagOccurrenceState } from "@agent-context/resolver";

import {
  MAX_TOKENIZER_INPUT_BYTES,
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
  compareTokenizerIdentities,
  validateTokenizerIdentity,
} from "./tokenizer-contract.js";
import type { TokenCount, TokenizerIdentity } from "./tokenizer-contract.js";

export const OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION = "0.1.0" as const;
export const OCCURRENCE_TOKEN_ACCOUNTING_LIMITS: Readonly<{
  maxDocuments: 4_096;
  maxOccurrences: 65_537;
}> = Object.freeze({
  maxDocuments: 4_096,
  maxOccurrences: 65_537,
} as const);

export type OccurrenceDisposition = "included" | "excluded" | "unknown";
export type OccurrenceActivation = "always" | "conditional";

export interface DocumentTokenMeasurement {
  readonly count: TokenCount;
  readonly documentId: string;
}

export interface OccurrenceTokenDecision {
  readonly activation: OccurrenceActivation | null;
  readonly count: TokenCount | null;
  readonly disposition: OccurrenceDisposition;
  readonly occurrenceId: string;
  readonly sourceBytesConsumed: number | null;
}

export interface AccountOccurrenceTokensInput {
  readonly dag: DocumentImportDag;
  readonly documentMeasurements: readonly DocumentTokenMeasurement[];
  readonly identity: TokenizerIdentity;
  readonly occurrenceDecisions: readonly OccurrenceTokenDecision[];
}

export interface CombineOccurrenceTokenAccountingsInput {
  /** One issued G03 result per effective top-level document DAG for the same profile/target. */
  readonly accountings: readonly OccurrenceTokenAccounting[];
}

export interface TokenAccountingTotals {
  /** Full tokens across every distinct source document in this DAG. */
  readonly raw: number;
  /** Consumed tokens from included non-entry import occurrences, including repetitions. */
  readonly imported: number;
  /** Full tokens for each distinct content identity reached by an included occurrence. */
  readonly unique: number;
  /** Consumed tokens from included occurrences classified as paid on every interaction. */
  readonly always: number;
  /** Consumed tokens from all included occurrences for this resolved target/trace. */
  readonly effective: number;
}

export interface DocumentTokenContribution {
  readonly contentId: string;
  readonly documentId: string;
  readonly path: string;
  readonly rawTokens: number;
  readonly sourceBytes: number;
}

export interface ContentTokenContribution {
  readonly contentId: string;
  readonly documentIds: readonly string[];
  readonly tokens: number;
}

export interface OccurrenceTokenContribution {
  readonly activation: OccurrenceActivation | null;
  readonly availableTokens: number | null;
  readonly consumedTokens: number | null;
  readonly disposition: OccurrenceDisposition;
  readonly occurrenceId: string;
  readonly ordinal: number;
  readonly sourceBytesAvailable: number | null;
  readonly sourceBytesConsumed: number | null;
  readonly state: ImportDagOccurrenceState;
  readonly targetDocumentId: string | null;
  readonly targetPath: string | null;
  readonly truncated: boolean | null;
}

export type TokenAccountingIssueCode =
  "graph-partial" | "parse-failed-document" | "unknown-occurrence";

export interface TokenAccountingIssue {
  readonly code: TokenAccountingIssueCode;
  readonly occurrenceId: string | null;
  readonly path: string;
}

export interface OccurrenceTokenAccounting {
  readonly recordKind: "agent-context-occurrence-token-accounting";
  readonly contractVersion: typeof OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION;
  readonly contents: readonly ContentTokenContribution[];
  readonly documents: readonly DocumentTokenContribution[];
  readonly identity: TokenizerIdentity;
  readonly issues: readonly TokenAccountingIssue[];
  readonly occurrences: readonly OccurrenceTokenContribution[];
  readonly state: "complete" | "partial";
  readonly totals: TokenAccountingTotals;
  readonly traceSha256: string;
}

export const OccurrenceTokenAccountingErrorCode: Readonly<{
  incompatibleTokenizer: "OCCURRENCE_TOKEN_ACCOUNTING_INCOMPATIBLE_TOKENIZER";
  invalidInput: "OCCURRENCE_TOKEN_ACCOUNTING_INVALID_INPUT";
  invalidRelationship: "OCCURRENCE_TOKEN_ACCOUNTING_INVALID_RELATIONSHIP";
  resourceLimit: "OCCURRENCE_TOKEN_ACCOUNTING_RESOURCE_LIMIT";
}> = Object.freeze({
  incompatibleTokenizer: "OCCURRENCE_TOKEN_ACCOUNTING_INCOMPATIBLE_TOKENIZER",
  invalidInput: "OCCURRENCE_TOKEN_ACCOUNTING_INVALID_INPUT",
  invalidRelationship: "OCCURRENCE_TOKEN_ACCOUNTING_INVALID_RELATIONSHIP",
  resourceLimit: "OCCURRENCE_TOKEN_ACCOUNTING_RESOURCE_LIMIT",
} as const);

export type OccurrenceTokenAccountingErrorCode =
  (typeof OccurrenceTokenAccountingErrorCode)[keyof typeof OccurrenceTokenAccountingErrorCode];

export class OccurrenceTokenAccountingError extends Error {
  readonly code: OccurrenceTokenAccountingErrorCode;

  constructor(code: OccurrenceTokenAccountingErrorCode, message: string) {
    super(message);
    this.name = "OccurrenceTokenAccountingError";
    this.code = code;
    Object.freeze(this);
  }
}

const ISSUED_OCCURRENCE_TOKEN_ACCOUNTINGS = new WeakSet<object>();

/** True only for base or combined G03 results issued in this process. */
export function isIssuedOccurrenceTokenAccounting(
  value: unknown,
): value is OccurrenceTokenAccounting {
  return (
    typeof value === "object" && value !== null && ISSUED_OCCURRENCE_TOKEN_ACCOUNTINGS.has(value)
  );
}

function issueAccounting(value: OccurrenceTokenAccounting): OccurrenceTokenAccounting {
  ISSUED_OCCURRENCE_TOKEN_ACCOUNTINGS.add(value);
  return value;
}

type DataRecord = Readonly<Record<string, unknown>>;

function fail(code: OccurrenceTokenAccountingErrorCode, message: string): never {
  throw new OccurrenceTokenAccountingError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} must be a non-proxy record`);
  }
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    actual = Reflect.ownKeys(value);
  } catch {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} cannot be inspected safely`);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} has unexpected fields`);
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.${key} is unsafe`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.${key} must be data`);
    }
  }
  return value as DataRecord;
}

function property(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} must be a regular array`);
  }
  if (value.length > maximum) {
    fail(OccurrenceTokenAccountingErrorCode.resourceLimit, `${label} exceeds its item limit`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} must be dense and unextended`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} contains an unsafe entry`);
    }
  }
  return value;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} must be bounded text`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidInput,
      `${label} must be a safe non-negative integer`,
    );
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label, 4_096);
}

function safeAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail(OccurrenceTokenAccountingErrorCode.resourceLimit, `${label} exceeds safe integer range`);
  }
  return sum;
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, message: string): V {
  const value = map.get(key);
  if (value === undefined) {
    fail(OccurrenceTokenAccountingErrorCode.invalidRelationship, message);
  }
  return value;
}

function normalizeCount(value: unknown, identity: TokenizerIdentity, label: string): TokenCount {
  const input = dataRecord(
    value,
    ["contractVersion", "identity", "inputCodeUnits", "inputUtf8Bytes", "tokens"],
    label,
  );
  if (property(input, "contractVersion") !== TOKENIZER_PLUGIN_CONTRACT_VERSION) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} has an unsupported contract`);
  }
  const candidateIdentity = property(input, "identity");
  const compatibility = compareTokenizerIdentities(identity, candidateIdentity);
  if (!compatibility.compatible) {
    fail(
      OccurrenceTokenAccountingErrorCode.incompatibleTokenizer,
      `${label} does not use the selected tokenizer identity`,
    );
  }
  return Object.freeze({
    contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
    identity,
    inputCodeUnits: integer(
      property(input, "inputCodeUnits"),
      `${label}.inputCodeUnits`,
      MAX_TOKENIZER_INPUT_BYTES,
    ),
    inputUtf8Bytes: integer(
      property(input, "inputUtf8Bytes"),
      `${label}.inputUtf8Bytes`,
      MAX_TOKENIZER_INPUT_BYTES,
    ),
    tokens: integer(property(input, "tokens"), `${label}.tokens`),
  });
}

interface NormalizedDocument {
  readonly byteLength: number;
  readonly contentId: string;
  readonly documentId: string;
  readonly path: string;
  readonly state: "loaded" | "parse-failed";
}

interface NormalizedOccurrence {
  readonly contentId: string | null;
  readonly id: string;
  readonly ordinal: number;
  readonly state: ImportDagOccurrenceState;
  readonly targetDocumentId: string | null;
  readonly targetPath: string | null;
}

function normalizeDag(value: unknown): {
  readonly contents: readonly {
    byteLength: number;
    id: string;
    documentIds: readonly string[];
  }[];
  readonly documents: readonly NormalizedDocument[];
  readonly graphState: "complete" | "partial";
  readonly occurrences: readonly NormalizedOccurrence[];
  readonly traceSha256: string;
} {
  const dag = dataRecord(
    value,
    [
      "recordKind",
      "contractVersion",
      "contents",
      "documents",
      "entryDocumentId",
      "entryPath",
      "graphState",
      "issues",
      "occurrences",
      "traceEventIds",
      "traceSha256",
    ],
    "dag",
  );
  if (
    property(dag, "recordKind") !== "agent-context-document-import-dag" ||
    property(dag, "contractVersion") !== "0.1.0"
  ) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, "dag contract is unsupported");
  }
  const entryPath = property(dag, "entryPath");
  if (typeof entryPath !== "string" || !isRepositoryRelativePath(entryPath)) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, "dag.entryPath is not canonical");
  }
  const graphState = property(dag, "graphState");
  if (graphState !== "complete" && graphState !== "partial") {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, "dag.graphState is invalid");
  }
  denseArray(property(dag, "issues"), 4_096, "dag.issues");
  const traceEvents = denseArray(property(dag, "traceEventIds"), 65_536, "dag.traceEventIds");
  for (const [index, event] of traceEvents.entries())
    text(event, `dag.traceEventIds[${String(index)}]`);
  const traceSha256 = text(property(dag, "traceSha256"), "dag.traceSha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(traceSha256)) {
    fail(OccurrenceTokenAccountingErrorCode.invalidInput, "dag.traceSha256 is invalid");
  }

  const documents = denseArray(
    property(dag, "documents"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    "dag.documents",
  ).map((value, index) => {
    const label = `dag.documents[${String(index)}]`;
    const item = dataRecord(
      value,
      ["byteLength", "contentId", "depth", "documentId", "path", "sourceId", "state"],
      label,
    );
    const path = property(item, "path");
    const state = property(item, "state");
    if (
      typeof path !== "string" ||
      !isRepositoryRelativePath(path) ||
      (state !== "loaded" && state !== "parse-failed")
    ) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label} is invalid`);
    }
    integer(property(item, "depth"), `${label}.depth`, 32);
    text(property(item, "sourceId"), `${label}.sourceId`);
    return Object.freeze({
      byteLength: integer(property(item, "byteLength"), `${label}.byteLength`, 524_288),
      contentId: text(property(item, "contentId"), `${label}.contentId`),
      documentId: text(property(item, "documentId"), `${label}.documentId`),
      path,
      state,
    });
  });
  const documentsById = new Map(documents.map((document) => [document.documentId, document]));
  if (documentsById.size !== documents.length) {
    fail(OccurrenceTokenAccountingErrorCode.invalidRelationship, "dag document IDs must be unique");
  }
  if (new Set(documents.map((document) => document.path)).size !== documents.length) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "dag document paths must be unique",
    );
  }

  const contents = denseArray(
    property(dag, "contents"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    "dag.contents",
  ).map((value, index) => {
    const label = `dag.contents[${String(index)}]`;
    const item = dataRecord(value, ["byteLength", "documentIds", "id", "sha256"], label);
    const byteLength = integer(property(item, "byteLength"), `${label}.byteLength`, 524_288);
    const sha256 = text(property(item, "sha256"), `${label}.sha256`, 64);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.sha256 is invalid`);
    }
    const documentIds = denseArray(
      property(item, "documentIds"),
      OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
      `${label}.documentIds`,
    ).map((id, itemIndex) => text(id, `${label}.documentIds[${String(itemIndex)}]`));
    if (documentIds.length === 0 || new Set(documentIds).size !== documentIds.length) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        `${label}.documentIds must be non-empty and unique`,
      );
    }
    const id = text(property(item, "id"), `${label}.id`);
    if (id !== `content:${sha256}`) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        `${label}.id and digest disagree`,
      );
    }
    return Object.freeze({
      byteLength,
      id,
      documentIds: Object.freeze(documentIds),
    });
  });
  const contentsById = new Map(contents.map((content) => [content.id, content]));
  if (contentsById.size !== contents.length) {
    fail(OccurrenceTokenAccountingErrorCode.invalidRelationship, "dag content IDs must be unique");
  }
  for (const document of documents) {
    const content = contentsById.get(document.contentId);
    if (!content?.documentIds.includes(document.documentId)) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag document/content membership disagrees",
      );
    }
  }
  for (const content of contents) {
    for (const documentId of content.documentIds) {
      const document = documentsById.get(documentId);
      if (document?.contentId !== content.id || document.byteLength !== content.byteLength) {
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "dag content membership or byte length disagrees",
        );
      }
    }
  }

  const states = new Set<ImportDagOccurrenceState>([
    "entry",
    "loaded",
    "already-loaded",
    "cycle",
    "ambiguous",
    "rejected",
    "unavailable",
    "limit-exceeded",
  ]);
  const occurrences = denseArray(
    property(dag, "occurrences"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences,
    "dag.occurrences",
  ).map((value, index) => {
    const label = `dag.occurrences[${String(index)}]`;
    const item = dataRecord(
      value,
      [
        "contentId",
        "depth",
        "fromDocumentId",
        "id",
        "importId",
        "issueCode",
        "ordinal",
        "range",
        "state",
        "targetDocumentId",
        "targetPath",
      ],
      label,
    );
    const state = property(item, "state");
    if (typeof state !== "string" || !states.has(state as ImportDagOccurrenceState)) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.state is invalid`);
    }
    integer(property(item, "depth"), `${label}.depth`, 33);
    const occurrence = Object.freeze({
      contentId: nullableText(property(item, "contentId"), `${label}.contentId`),
      id: text(property(item, "id"), `${label}.id`),
      ordinal: integer(
        property(item, "ordinal"),
        `${label}.ordinal`,
        OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences,
      ),
      state: state as ImportDagOccurrenceState,
      targetDocumentId: nullableText(
        property(item, "targetDocumentId"),
        `${label}.targetDocumentId`,
      ),
      targetPath: nullableText(property(item, "targetPath"), `${label}.targetPath`),
    });
    if (occurrence.targetPath !== null && !isRepositoryRelativePath(occurrence.targetPath)) {
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.targetPath is not canonical`);
    }
    if (occurrence.ordinal !== index) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag occurrence order disagrees",
      );
    }
    if (occurrence.targetDocumentId === null) {
      if (occurrence.contentId !== null)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "targetless occurrence has content",
        );
    } else {
      const document = documentsById.get(occurrence.targetDocumentId);
      if (
        document?.contentId !== occurrence.contentId ||
        (state !== "cycle" && document.path !== occurrence.targetPath)
      ) {
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "dag occurrence target disagrees",
        );
      }
    }
    const loadsContent =
      state === "entry" || state === "loaded" || state === "already-loaded" || state === "cycle";
    if (loadsContent !== (occurrence.targetDocumentId !== null)) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag occurrence state and target disagree",
      );
    }
    if ((index === 0) !== (state === "entry")) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag must have one leading entry occurrence",
      );
    }
    return occurrence;
  });
  if (new Set(occurrences.map((occurrence) => occurrence.id)).size !== occurrences.length) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "dag occurrence IDs must be unique",
    );
  }
  const entryDocumentId = property(dag, "entryDocumentId");
  if (entryDocumentId === null) {
    if (documents.length !== 0 || contents.length !== 0 || occurrences.length !== 0) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag without an entry cannot contain loaded graph records",
      );
    }
  } else {
    const normalizedEntryId = text(entryDocumentId, "dag.entryDocumentId");
    const entryDocument = documentsById.get(normalizedEntryId);
    const entryOccurrence = occurrences[0];
    if (
      entryDocument?.path !== entryPath ||
      entryOccurrence?.targetDocumentId !== normalizedEntryId ||
      entryOccurrence.targetPath !== entryPath
    ) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "dag entry relationships disagree",
      );
    }
  }
  return Object.freeze({
    contents: Object.freeze(contents),
    documents: Object.freeze(documents),
    graphState,
    occurrences: Object.freeze(occurrences),
    traceSha256,
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameDocument(left: DocumentTokenContribution, right: DocumentTokenContribution): boolean {
  return (
    left.contentId === right.contentId &&
    left.path === right.path &&
    left.rawTokens === right.rawTokens &&
    left.sourceBytes === right.sourceBytes
  );
}

/** Combine genuine G03 results for multiple top-level DAGs in one profile/target trace. */
export function combineOccurrenceTokenAccountings(
  inputValue: CombineOccurrenceTokenAccountingsInput,
): OccurrenceTokenAccounting {
  const input = dataRecord(inputValue, ["accountings"], "input");
  const raw = denseArray(
    property(input, "accountings"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    "input.accountings",
  );
  if (raw.length === 0)
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "at least one issued G03 accounting is required",
    );
  const accountings = raw.map((value, index) => {
    if (!isIssuedOccurrenceTokenAccounting(value))
      fail(
        OccurrenceTokenAccountingErrorCode.invalidInput,
        `input.accountings[${String(index)}] must be an issued G03 result`,
      );
    return value;
  });
  const first = accountings[0];
  if (first === undefined)
    fail(OccurrenceTokenAccountingErrorCode.invalidRelationship, "accounting disappeared");
  for (const accounting of accountings.slice(1)) {
    if (!compareTokenizerIdentities(first.identity, accounting.identity).compatible)
      fail(
        OccurrenceTokenAccountingErrorCode.incompatibleTokenizer,
        "combined G03 accountings use incompatible tokenizer identities",
      );
    if (accounting.traceSha256 !== first.traceSha256)
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "combined G03 accountings must describe one resolution trace",
      );
  }
  let documentWork = 0;
  let contentWork = 0;
  let occurrenceWork = 0;
  let issueWork = 0;
  for (const accounting of accountings) {
    documentWork = safeAdd(documentWork, accounting.documents.length, "composition document work");
    contentWork = safeAdd(contentWork, accounting.contents.length, "composition content work");
    occurrenceWork = safeAdd(
      occurrenceWork,
      accounting.occurrences.length,
      "composition occurrence work",
    );
    issueWork = safeAdd(issueWork, accounting.issues.length, "composition issue work");
    if (
      documentWork > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments ||
      contentWork > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments ||
      occurrenceWork > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences ||
      issueWork > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences
    )
      fail(
        OccurrenceTokenAccountingErrorCode.resourceLimit,
        "combined G03 input work exceeds its aggregate resource limits",
      );
  }
  const rootPaths = new Set<string>();
  const ordered = accountings
    .map((accounting) => {
      const entries = accounting.occurrences.filter((entry) => entry.state === "entry");
      const entry = entries[0];
      if (entries.length !== 1 || entry?.targetPath === null || entry === undefined)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "each combined G03 accounting must contain exactly one top-level entry",
        );
      if (rootPaths.has(entry.targetPath))
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "combined G03 accountings duplicate a top-level document",
        );
      rootPaths.add(entry.targetPath);
      return { accounting, rootPath: entry.targetPath };
    })
    .sort((left, right) => compareUtf8(left.rootPath, right.rootPath));

  const documentById = new Map<string, DocumentTokenContribution>();
  const documentIdByPath = new Map<string, string>();
  const contentById = new Map<
    string,
    { readonly documentIds: Set<string>; readonly tokens: number }
  >();
  const occurrenceIds = new Set<string>();
  const occurrences: OccurrenceTokenContribution[] = [];
  const issues = new Map<string, TokenAccountingIssue>();
  for (const { accounting, rootPath } of ordered) {
    const remappedOccurrenceIds = new Map<string, string>();
    for (const document of accounting.documents) {
      const existing = documentById.get(document.documentId);
      const pathOwner = documentIdByPath.get(document.path);
      if (
        (existing !== undefined && !sameDocument(existing, document)) ||
        (pathOwner !== undefined && pathOwner !== document.documentId)
      )
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "overlapping G03 document contributions conflict",
        );
      documentById.set(document.documentId, document);
      documentIdByPath.set(document.path, document.documentId);
    }
    for (const content of accounting.contents) {
      const existing = contentById.get(content.contentId);
      if (existing !== undefined && existing.tokens !== content.tokens)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "overlapping G03 content contributions conflict",
        );
      const aggregate = existing ?? { documentIds: new Set<string>(), tokens: content.tokens };
      for (const documentId of content.documentIds) aggregate.documentIds.add(documentId);
      contentById.set(content.contentId, aggregate);
    }
    for (const occurrence of accounting.occurrences) {
      const occurrenceId = `occurrence:combined:${createHash("sha256")
        .update("g03-combined-occurrence-v1\0", "utf8")
        .update(rootPath, "utf8")
        .update("\0", "utf8")
        .update(occurrence.occurrenceId, "utf8")
        .digest("hex")}`;
      if (occurrenceIds.has(occurrenceId))
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "combined G03 occurrence identities collide",
        );
      occurrenceIds.add(occurrenceId);
      remappedOccurrenceIds.set(occurrence.occurrenceId, occurrenceId);
      occurrences.push(Object.freeze({ ...occurrence, occurrenceId, ordinal: occurrences.length }));
    }
    for (const issue of accounting.issues) {
      const occurrenceId =
        issue.occurrenceId === null
          ? null
          : (remappedOccurrenceIds.get(issue.occurrenceId) ?? null);
      if (issue.occurrenceId !== null && occurrenceId === null)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "combined G03 issue occurrence is unavailable",
        );
      const remapped = Object.freeze({ ...issue, occurrenceId });
      const key = `${remapped.code}\0${remapped.occurrenceId ?? ""}\0${remapped.path}`;
      issues.set(key, remapped);
    }
  }
  if (
    documentById.size > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments ||
    contentById.size > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments ||
    occurrences.length > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences ||
    issues.size > OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences
  )
    fail(
      OccurrenceTokenAccountingErrorCode.resourceLimit,
      "combined G03 evidence exceeds its resource limits",
    );
  const documents = Object.freeze(
    [...documentById.values()].sort(
      (left, right) =>
        compareUtf8(left.path, right.path) || compareUtf8(left.documentId, right.documentId),
    ),
  );
  const contents = Object.freeze(
    [...contentById.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([contentId, content]) =>
        Object.freeze({
          contentId,
          documentIds: Object.freeze([...content.documentIds].sort(compareUtf8)),
          tokens: content.tokens,
        }),
      ),
  );
  let rawTokens = 0;
  let imported = 0;
  let always = 0;
  let effective = 0;
  const reachedContents = new Set<string>();
  for (const document of documents)
    rawTokens = safeAdd(rawTokens, document.rawTokens, "combined raw token total");
  for (const occurrence of occurrences) {
    if (occurrence.disposition !== "included") continue;
    const consumed = occurrence.consumedTokens ?? 0;
    effective = safeAdd(effective, consumed, "combined effective token total");
    if (occurrence.state !== "entry")
      imported = safeAdd(imported, consumed, "combined imported token total");
    if (occurrence.activation === "always")
      always = safeAdd(always, consumed, "combined always-on token total");
    const target =
      occurrence.targetDocumentId === null
        ? undefined
        : documentById.get(occurrence.targetDocumentId);
    if (target === undefined)
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "combined included occurrence has no document contribution",
      );
    reachedContents.add(target.contentId);
  }
  let unique = 0;
  for (const contentId of reachedContents) {
    const content = contentById.get(contentId);
    if (content === undefined)
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "combined reached content contribution disappeared",
      );
    unique = safeAdd(unique, content.tokens, "combined unique token total");
  }
  const mergedIssues = Object.freeze(
    [...issues.values()].sort(
      (left, right) =>
        compareUtf8(left.path, right.path) ||
        compareUtf8(left.code, right.code) ||
        compareUtf8(left.occurrenceId ?? "", right.occurrenceId ?? ""),
    ),
  );
  return issueAccounting(
    Object.freeze({
      contractVersion: OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION,
      contents,
      documents,
      identity: first.identity,
      issues: mergedIssues,
      occurrences: Object.freeze(occurrences),
      recordKind: "agent-context-occurrence-token-accounting",
      state: mergedIssues.length === 0 ? "complete" : "partial",
      totals: Object.freeze({ always, effective, imported, raw: rawTokens, unique }),
      traceSha256: first.traceSha256,
    }),
  );
}

/**
 * Reconcile source, import, unique-content, always-on, and effective token totals.
 *
 * The caller must supply one explicit decision per occurrence. This deliberately prevents the
 * accounting layer from inventing client-specific loading, activation, or repeated-import rules.
 */
export function accountOccurrenceTokens(
  inputValue: AccountOccurrenceTokensInput,
): OccurrenceTokenAccounting {
  const input = dataRecord(
    inputValue,
    ["dag", "documentMeasurements", "identity", "occurrenceDecisions"],
    "input",
  );
  const identityResult = validateTokenizerIdentity(property(input, "identity"));
  if (!identityResult.ok) {
    fail(
      OccurrenceTokenAccountingErrorCode.incompatibleTokenizer,
      "selected tokenizer identity is invalid",
    );
  }
  const identity = identityResult.value;
  const dag = normalizeDag(property(input, "dag"));
  const rawMeasurements = denseArray(
    property(input, "documentMeasurements"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    "documentMeasurements",
  );
  const measurements = new Map<string, TokenCount>();
  for (const [index, value] of rawMeasurements.entries()) {
    const label = `documentMeasurements[${String(index)}]`;
    const item = dataRecord(value, ["count", "documentId"], label);
    const documentId = text(property(item, "documentId"), `${label}.documentId`);
    if (measurements.has(documentId))
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "document measurement IDs must be unique",
      );
    measurements.set(
      documentId,
      normalizeCount(property(item, "count"), identity, `${label}.count`),
    );
  }
  if (
    measurements.size !== dag.documents.length ||
    dag.documents.some((document) => !measurements.has(document.documentId))
  ) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "every DAG document needs exactly one token measurement",
    );
  }

  const contentCounts = new Map<string, TokenCount>();
  let raw = 0;
  const documents = dag.documents.map((document) => {
    const count = requiredMapValue(
      measurements,
      document.documentId,
      "DAG document measurement disappeared",
    );
    raw = safeAdd(raw, count.tokens, "raw token total");
    const existing = contentCounts.get(document.contentId);
    if (
      existing !== undefined &&
      (existing.tokens !== count.tokens ||
        existing.inputUtf8Bytes !== count.inputUtf8Bytes ||
        existing.inputCodeUnits !== count.inputCodeUnits)
    ) {
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "identical content has conflicting token measurements",
      );
    }
    contentCounts.set(document.contentId, count);
    return Object.freeze({
      contentId: document.contentId,
      documentId: document.documentId,
      path: document.path,
      rawTokens: count.tokens,
      sourceBytes: document.byteLength,
    });
  });
  if (
    contentCounts.size !== dag.contents.length ||
    dag.contents.some((content) => !contentCounts.has(content.id))
  ) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "DAG content and measurements disagree",
    );
  }
  const contents = dag.contents.map((content) =>
    Object.freeze({
      contentId: content.id,
      documentIds: content.documentIds,
      tokens: requiredMapValue(contentCounts, content.id, "DAG content measurement disappeared")
        .tokens,
    }),
  );

  const rawDecisions = denseArray(
    property(input, "occurrenceDecisions"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences,
    "occurrenceDecisions",
  );
  const decisions = new Map<
    string,
    {
      activation: OccurrenceActivation | null;
      count: TokenCount | null;
      disposition: OccurrenceDisposition;
      sourceBytesConsumed: number | null;
    }
  >();
  for (const [index, value] of rawDecisions.entries()) {
    const label = `occurrenceDecisions[${String(index)}]`;
    const item = dataRecord(
      value,
      ["activation", "count", "disposition", "occurrenceId", "sourceBytesConsumed"],
      label,
    );
    const occurrenceId = text(property(item, "occurrenceId"), `${label}.occurrenceId`);
    if (decisions.has(occurrenceId))
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "occurrence decision IDs must be unique",
      );
    const disposition = property(item, "disposition");
    const activation = property(item, "activation");
    if (disposition !== "included" && disposition !== "excluded" && disposition !== "unknown")
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.disposition is invalid`);
    if (activation !== null && activation !== "always" && activation !== "conditional")
      fail(OccurrenceTokenAccountingErrorCode.invalidInput, `${label}.activation is invalid`);
    const countValue = property(item, "count");
    const bytesValue = property(item, "sourceBytesConsumed");
    if (disposition === "included") {
      if (activation === null || countValue === null || bytesValue === null)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "included occurrence needs activation, count, and consumed bytes",
        );
      decisions.set(occurrenceId, {
        activation,
        count: normalizeCount(countValue, identity, `${label}.count`),
        disposition,
        sourceBytesConsumed: integer(bytesValue, `${label}.sourceBytesConsumed`, 524_288),
      });
    } else {
      if (activation !== null || countValue !== null || bytesValue !== null)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "non-included occurrence cannot contribute tokens or activation",
        );
      decisions.set(occurrenceId, {
        activation: null,
        count: null,
        disposition,
        sourceBytesConsumed: null,
      });
    }
  }
  if (
    decisions.size !== dag.occurrences.length ||
    dag.occurrences.some((occurrence) => !decisions.has(occurrence.id))
  ) {
    fail(
      OccurrenceTokenAccountingErrorCode.invalidRelationship,
      "every DAG occurrence needs exactly one decision",
    );
  }

  const documentsById = new Map(dag.documents.map((document) => [document.documentId, document]));
  const reachedContents = new Set<string>();
  const issues: TokenAccountingIssue[] = [];
  if (dag.graphState === "partial")
    issues.push(Object.freeze({ code: "graph-partial", occurrenceId: null, path: "$dag" }));
  for (const document of dag.documents) {
    if (document.state === "parse-failed")
      issues.push(
        Object.freeze({ code: "parse-failed-document", occurrenceId: null, path: document.path }),
      );
  }
  let imported = 0;
  let always = 0;
  let effective = 0;
  const occurrences = dag.occurrences.map((occurrence) => {
    const decision = requiredMapValue(
      decisions,
      occurrence.id,
      "DAG occurrence decision disappeared",
    );
    const target =
      occurrence.targetDocumentId === null
        ? undefined
        : documentsById.get(occurrence.targetDocumentId);
    const available =
      target === undefined
        ? null
        : requiredMapValue(measurements, target.documentId, "DAG target measurement disappeared");
    if (decision.disposition === "included" && target === undefined)
      fail(
        OccurrenceTokenAccountingErrorCode.invalidRelationship,
        "targetless occurrence cannot be included",
      );
    if (decision.disposition === "unknown")
      issues.push(
        Object.freeze({
          code: "unknown-occurrence",
          occurrenceId: occurrence.id,
          path: occurrence.targetPath ?? "$unresolved",
        }),
      );
    let truncated: boolean | null = null;
    if (decision.disposition === "included") {
      const count = decision.count;
      const consumedBytes = decision.sourceBytesConsumed;
      if (count === null || consumedBytes === null || target === undefined || available === null) {
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "included occurrence contribution is incomplete",
        );
      }
      if (consumedBytes > target.byteLength)
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "occurrence consumes more source bytes than available",
        );
      if (
        count.inputCodeUnits > available.inputCodeUnits ||
        count.inputUtf8Bytes > available.inputUtf8Bytes
      ) {
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "occurrence count input exceeds its full document measurement",
        );
      }
      if (
        consumedBytes === target.byteLength &&
        (count.tokens !== available.tokens ||
          count.inputUtf8Bytes !== available.inputUtf8Bytes ||
          count.inputCodeUnits !== available.inputCodeUnits)
      ) {
        fail(
          OccurrenceTokenAccountingErrorCode.invalidRelationship,
          "untruncated occurrence count must equal its document count",
        );
      }
      effective = safeAdd(effective, count.tokens, "effective token total");
      if (occurrence.state !== "entry")
        imported = safeAdd(imported, count.tokens, "imported token total");
      if (decision.activation === "always")
        always = safeAdd(always, count.tokens, "always-on token total");
      reachedContents.add(target.contentId);
      truncated = consumedBytes < target.byteLength;
    }
    return Object.freeze({
      activation: decision.activation,
      availableTokens: available?.tokens ?? null,
      consumedTokens: decision.count?.tokens ?? null,
      disposition: decision.disposition,
      occurrenceId: occurrence.id,
      ordinal: occurrence.ordinal,
      sourceBytesAvailable: target?.byteLength ?? null,
      sourceBytesConsumed: decision.sourceBytesConsumed,
      state: occurrence.state,
      targetDocumentId: occurrence.targetDocumentId,
      targetPath: occurrence.targetPath,
      truncated,
    });
  });
  let unique = 0;
  for (const contentId of reachedContents) {
    const count = requiredMapValue(
      contentCounts,
      contentId,
      "reached content measurement disappeared",
    );
    unique = safeAdd(unique, count.tokens, "unique token total");
  }
  const state = issues.length === 0 ? "complete" : "partial";
  return issueAccounting(
    Object.freeze({
      recordKind: "agent-context-occurrence-token-accounting",
      contractVersion: OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION,
      contents: Object.freeze(contents),
      documents: Object.freeze(documents),
      identity,
      issues: Object.freeze(issues),
      occurrences: Object.freeze(occurrences),
      state,
      totals: Object.freeze({ raw, imported, unique, always, effective }),
      traceSha256: dag.traceSha256,
    }),
  );
}
