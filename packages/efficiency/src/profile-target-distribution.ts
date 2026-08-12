import { types as nodeTypes } from "node:util";

import { compareRepositoryRelativePaths, isRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import { TARGET_SAMPLER_CONTRACT_VERSION } from "@agent-context/resolver";
import type { TargetSamplingResult } from "@agent-context/resolver";

import {
  OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION,
  OCCURRENCE_TOKEN_ACCOUNTING_LIMITS,
} from "./occurrence-token-accounting.js";
import type { OccurrenceTokenAccounting } from "./occurrence-token-accounting.js";
import { compareTokenizerIdentities, validateTokenizerIdentity } from "./tokenizer-contract.js";
import type { TokenizerIdentity } from "./tokenizer-contract.js";

export const PROFILE_TARGET_DISTRIBUTION_CONTRACT_VERSION = "0.2.0" as const;
export const PROFILE_TARGET_DISTRIBUTION_PERCENTILE_METHOD = "empirical-nearest-rank-v1" as const;
export const PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS = 100_000 as const;

export interface ProfileTargetIdentity {
  readonly clientVersion: string | null;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}

export interface ProfileTargetAccounting {
  readonly accounting: OccurrenceTokenAccounting;
  readonly path: RepositoryRelativePath;
}

export interface AggregateProfileTargetDistributionInput {
  readonly accountings: readonly ProfileTargetAccounting[];
  readonly identity: TokenizerIdentity;
  readonly profile: ProfileTargetIdentity;
  readonly sampling: TargetSamplingResult;
}

export interface ProfileTargetTokenObservation {
  readonly alwaysOnTokens: number;
  readonly effectiveTokens: number;
  readonly includedInStatistics: boolean;
  readonly path: RepositoryRelativePath;
  readonly state: "complete" | "partial";
  readonly traceSha256: string;
}

export interface ProfileTargetTokenStatistics {
  readonly maximum: number;
  readonly minimum: number;
  readonly p50: number;
  readonly p95: number;
}

export type ProfileTargetDistributionIssueCode =
  "accounting-partial" | "no-complete-targets" | "sampling-partial";

export interface ProfileTargetDistributionIssue {
  readonly code: ProfileTargetDistributionIssueCode;
  readonly path: RepositoryRelativePath | null;
}

export interface ProfileTargetDistribution {
  readonly completeSampleCount: number;
  readonly contractVersion: typeof PROFILE_TARGET_DISTRIBUTION_CONTRACT_VERSION;
  readonly issues: readonly ProfileTargetDistributionIssue[];
  readonly percentileMethod: typeof PROFILE_TARGET_DISTRIBUTION_PERCENTILE_METHOD;
  readonly profile: ProfileTargetIdentity;
  readonly recordKind: "agent-context-profile-target-token-distribution";
  readonly sampleCount: number;
  readonly sampling: {
    readonly contractVersion: typeof TARGET_SAMPLER_CONTRACT_VERSION;
    readonly state: "complete" | "partial";
    readonly strategy: "exhaustive" | "stratified";
  };
  readonly state: "complete" | "empty" | "partial";
  readonly statistics: ProfileTargetTokenStatistics | null;
  readonly targets: readonly ProfileTargetTokenObservation[];
  readonly tokenizer: TokenizerIdentity;
}

export const ProfileTargetDistributionErrorCode: Readonly<{
  incompatibleTokenizer: "PROFILE_TARGET_DISTRIBUTION_INCOMPATIBLE_TOKENIZER";
  invalidInput: "PROFILE_TARGET_DISTRIBUTION_INVALID_INPUT";
  invalidRelationship: "PROFILE_TARGET_DISTRIBUTION_INVALID_RELATIONSHIP";
  resourceLimit: "PROFILE_TARGET_DISTRIBUTION_RESOURCE_LIMIT";
}> = Object.freeze({
  incompatibleTokenizer: "PROFILE_TARGET_DISTRIBUTION_INCOMPATIBLE_TOKENIZER",
  invalidInput: "PROFILE_TARGET_DISTRIBUTION_INVALID_INPUT",
  invalidRelationship: "PROFILE_TARGET_DISTRIBUTION_INVALID_RELATIONSHIP",
  resourceLimit: "PROFILE_TARGET_DISTRIBUTION_RESOURCE_LIMIT",
} as const);

export type ProfileTargetDistributionErrorCode =
  (typeof ProfileTargetDistributionErrorCode)[keyof typeof ProfileTargetDistributionErrorCode];

export class ProfileTargetDistributionError extends Error {
  readonly code: ProfileTargetDistributionErrorCode;

  constructor(code: ProfileTargetDistributionErrorCode, message: string) {
    super(message);
    this.name = "ProfileTargetDistributionError";
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const VERSION = /^[A-Za-z0-9]+(?:[._+:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_ID = /^content:[a-f0-9]{64}$/u;
const OCCURRENCE_STATES = new Set([
  "already-loaded",
  "ambiguous",
  "cycle",
  "entry",
  "limit-exceeded",
  "loaded",
  "rejected",
  "unavailable",
]);
const ACCOUNTING_ISSUE_CODES = new Set([
  "graph-partial",
  "parse-failed-document",
  "unknown-occurrence",
]);

function fail(code: ProfileTargetDistributionErrorCode, message: string): never {
  throw new ProfileTargetDistributionError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} must be a non-proxy record`);
  }
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    actual = Reflect.ownKeys(value);
  } catch {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} cannot be inspected safely`);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} has unexpected fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.${key} must be data`);
    }
  }
  return value as DataRecord;
}

function property(value: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} must be a regular array`);
  }
  if (value.length > maximum) {
    fail(ProfileTargetDistributionErrorCode.resourceLimit, `${label} exceeds its item limit`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} must be dense and unextended`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} contains an unsafe entry`);
    }
  }
  return value;
}

function boundedText(value: unknown, label: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !pattern.test(value)
  ) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} is invalid`);
  }
  return value;
}

function boundedClientVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} is invalid`);
  }
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${label} is invalid`);
    }
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || value === "." || !isRepositoryRelativePath(value)) {
    fail(
      ProfileTargetDistributionErrorCode.invalidInput,
      `${label} must be a canonical repository file path`,
    );
  }
  return value;
}

function accountingIssuePath(value: unknown, label: string): string {
  return value === "$dag" || value === "$unresolved" ? value : pathValue(value, label);
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      ProfileTargetDistributionErrorCode.invalidInput,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function nullableText(value: unknown, label: string, pattern: RegExp): string | null {
  return value === null ? null : boundedText(value, label, pattern);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    fail(ProfileTargetDistributionErrorCode.resourceLimit, `${label} exceeds safe integer range`);
  }
  return result;
}

function normalizeProfile(value: unknown): ProfileTargetIdentity {
  const profile = dataRecord(
    value,
    ["clientVersion", "profileId", "profileVersion", "specSnapshotId", "surfaceId"],
    "profile",
  );
  const clientVersionValue = property(profile, "clientVersion");
  const clientVersion =
    clientVersionValue === null
      ? null
      : boundedClientVersion(clientVersionValue, "profile.clientVersion");
  return Object.freeze({
    clientVersion,
    profileId: boundedText(property(profile, "profileId"), "profile.profileId", IDENTIFIER),
    profileVersion: boundedText(
      property(profile, "profileVersion"),
      "profile.profileVersion",
      VERSION,
    ),
    specSnapshotId: boundedText(
      property(profile, "specSnapshotId"),
      "profile.specSnapshotId",
      IDENTIFIER,
    ),
    surfaceId: boundedText(property(profile, "surfaceId"), "profile.surfaceId", IDENTIFIER),
  });
}

function normalizeSampling(value: unknown): {
  readonly paths: readonly RepositoryRelativePath[];
  readonly state: "complete" | "partial";
  readonly strategy: "exhaustive" | "stratified";
} {
  const sampling = dataRecord(
    value,
    [
      "recordKind",
      "contractVersion",
      "coverage",
      "limits",
      "metrics",
      "provenance",
      "selected",
      "state",
      "strategy",
    ],
    "sampling",
  );
  if (property(sampling, "recordKind") !== "agent-context-target-sampling") {
    fail(ProfileTargetDistributionErrorCode.invalidInput, "sampling.recordKind is invalid");
  }
  if (property(sampling, "contractVersion") !== TARGET_SAMPLER_CONTRACT_VERSION) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, "sampling.contractVersion is invalid");
  }
  const state = property(sampling, "state");
  if (state !== "complete" && state !== "partial") {
    fail(ProfileTargetDistributionErrorCode.invalidInput, "sampling.state is invalid");
  }
  const strategy = property(sampling, "strategy");
  if (strategy !== "exhaustive" && strategy !== "stratified") {
    fail(ProfileTargetDistributionErrorCode.invalidInput, "sampling.strategy is invalid");
  }
  const selected = denseArray(
    property(sampling, "selected"),
    PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS,
    "sampling.selected",
  );
  const paths = selected.map((value, index) => {
    const target = dataRecord(
      value,
      ["activationPartitionId", "language", "path", "reasons"],
      `sampling.selected[${String(index)}]`,
    );
    return pathValue(property(target, "path"), `sampling.selected[${String(index)}].path`);
  });
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareRepositoryRelativePaths(previous, current) >= 0
    ) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        "sampling.selected paths must be unique and canonically ordered",
      );
    }
  }
  return Object.freeze({ paths: Object.freeze(paths), state, strategy });
}

function normalizeTotals(
  value: unknown,
  label: string,
): {
  readonly always: number;
  readonly effective: number;
  readonly imported: number;
  readonly raw: number;
  readonly unique: number;
} {
  const totals = dataRecord(value, ["raw", "imported", "unique", "always", "effective"], label);
  const raw = safeInteger(property(totals, "raw"), `${label}.raw`);
  const imported = safeInteger(property(totals, "imported"), `${label}.imported`);
  const unique = safeInteger(property(totals, "unique"), `${label}.unique`);
  const always = safeInteger(property(totals, "always"), `${label}.always`);
  const effective = safeInteger(property(totals, "effective"), `${label}.effective`);
  if (imported > effective || always > effective) {
    fail(
      ProfileTargetDistributionErrorCode.invalidRelationship,
      `${label} contains impossible token totals`,
    );
  }
  return Object.freeze({ always, effective, imported, raw, unique });
}

interface AccountingDocument {
  readonly contentId: string;
  readonly path: RepositoryRelativePath;
  readonly rawTokens: number;
  readonly sourceBytes: number;
}

interface AccountingEvidence {
  readonly contentTokens: ReadonlyMap<string, number>;
  readonly documents: ReadonlyMap<string, AccountingDocument>;
  readonly raw: number;
}

function normalizeDocumentEvidence(accounting: DataRecord, label: string): AccountingEvidence {
  const rawDocuments = denseArray(
    property(accounting, "documents"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    `${label}.documents`,
  );
  const documents = new Map<string, AccountingDocument>();
  let raw = 0;
  for (const [index, value] of rawDocuments.entries()) {
    const itemLabel = `${label}.documents[${String(index)}]`;
    const item = dataRecord(
      value,
      ["contentId", "documentId", "path", "rawTokens", "sourceBytes"],
      itemLabel,
    );
    const documentId = boundedText(
      property(item, "documentId"),
      `${itemLabel}.documentId`,
      IDENTIFIER,
    );
    const contentId = boundedText(
      property(item, "contentId"),
      `${itemLabel}.contentId`,
      CONTENT_ID,
    );
    const path = pathValue(property(item, "path"), `${itemLabel}.path`);
    const rawTokens = safeInteger(property(item, "rawTokens"), `${itemLabel}.rawTokens`);
    const sourceBytes = safeInteger(property(item, "sourceBytes"), `${itemLabel}.sourceBytes`);
    if (documents.has(documentId)) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${label} duplicates a document`,
      );
    }
    documents.set(documentId, Object.freeze({ contentId, path, rawTokens, sourceBytes }));
    raw = safeAdd(raw, rawTokens, "raw token total");
  }

  const rawContents = denseArray(
    property(accounting, "contents"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
    `${label}.contents`,
  );
  const contentTokens = new Map<string, number>();
  const contentMembers = new Set<string>();
  for (const [index, value] of rawContents.entries()) {
    const itemLabel = `${label}.contents[${String(index)}]`;
    const item = dataRecord(value, ["contentId", "documentIds", "tokens"], itemLabel);
    const contentId = boundedText(
      property(item, "contentId"),
      `${itemLabel}.contentId`,
      CONTENT_ID,
    );
    if (contentTokens.has(contentId)) {
      fail(ProfileTargetDistributionErrorCode.invalidRelationship, `${label} duplicates content`);
    }
    const tokens = safeInteger(property(item, "tokens"), `${itemLabel}.tokens`);
    const documentIds = denseArray(
      property(item, "documentIds"),
      OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxDocuments,
      `${itemLabel}.documentIds`,
    );
    if (documentIds.length === 0) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${itemLabel} must name documents`,
      );
    }
    for (const [documentIndex, documentValue] of documentIds.entries()) {
      const documentId = boundedText(
        documentValue,
        `${itemLabel}.documentIds[${String(documentIndex)}]`,
        IDENTIFIER,
      );
      const document = documents.get(documentId);
      if (
        document?.contentId !== contentId ||
        document.rawTokens !== tokens ||
        contentMembers.has(documentId)
      ) {
        fail(
          ProfileTargetDistributionErrorCode.invalidRelationship,
          `${itemLabel} disagrees with document evidence`,
        );
      }
      contentMembers.add(documentId);
    }
    contentTokens.set(contentId, tokens);
  }
  if (contentMembers.size !== documents.size) {
    fail(
      ProfileTargetDistributionErrorCode.invalidRelationship,
      `${label} omits document content membership`,
    );
  }
  return Object.freeze({ contentTokens, documents, raw });
}

function normalizeOccurrenceEvidence(
  accounting: DataRecord,
  evidence: AccountingEvidence,
  label: string,
): Omit<ReturnType<typeof normalizeTotals>, "raw"> {
  const rawOccurrences = denseArray(
    property(accounting, "occurrences"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences,
    `${label}.occurrences`,
  );
  const occurrenceIds = new Set<string>();
  const reachedContents = new Set<string>();
  let imported = 0;
  let always = 0;
  let effective = 0;
  for (const [index, value] of rawOccurrences.entries()) {
    const itemLabel = `${label}.occurrences[${String(index)}]`;
    const item = dataRecord(
      value,
      [
        "activation",
        "availableTokens",
        "consumedTokens",
        "disposition",
        "occurrenceId",
        "ordinal",
        "sourceBytesAvailable",
        "sourceBytesConsumed",
        "state",
        "targetDocumentId",
        "targetPath",
        "truncated",
      ],
      itemLabel,
    );
    const occurrenceId = boundedText(
      property(item, "occurrenceId"),
      `${itemLabel}.occurrenceId`,
      IDENTIFIER,
    );
    if (occurrenceIds.has(occurrenceId) || property(item, "ordinal") !== index) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${itemLabel} has invalid identity or order`,
      );
    }
    occurrenceIds.add(occurrenceId);
    const occurrenceState = property(item, "state");
    if (typeof occurrenceState !== "string" || !OCCURRENCE_STATES.has(occurrenceState)) {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${itemLabel}.state is invalid`);
    }
    const disposition = property(item, "disposition");
    if (disposition !== "included" && disposition !== "excluded" && disposition !== "unknown") {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${itemLabel}.disposition is invalid`);
    }
    const activation = property(item, "activation");
    if (activation !== null && activation !== "always" && activation !== "conditional") {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${itemLabel}.activation is invalid`);
    }
    const availableTokens = nullableInteger(
      property(item, "availableTokens"),
      `${itemLabel}.availableTokens`,
    );
    const consumedTokens = nullableInteger(
      property(item, "consumedTokens"),
      `${itemLabel}.consumedTokens`,
    );
    const sourceBytesAvailable = nullableInteger(
      property(item, "sourceBytesAvailable"),
      `${itemLabel}.sourceBytesAvailable`,
    );
    const sourceBytesConsumed = nullableInteger(
      property(item, "sourceBytesConsumed"),
      `${itemLabel}.sourceBytesConsumed`,
    );
    const targetDocumentId = nullableText(
      property(item, "targetDocumentId"),
      `${itemLabel}.targetDocumentId`,
      IDENTIFIER,
    );
    const rawTargetPath = property(item, "targetPath");
    const targetPath =
      rawTargetPath === null ? null : pathValue(rawTargetPath, `${itemLabel}.targetPath`);
    const truncated = property(item, "truncated");
    if (truncated !== null && typeof truncated !== "boolean") {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${itemLabel}.truncated is invalid`);
    }
    const document =
      targetDocumentId === null ? undefined : evidence.documents.get(targetDocumentId);
    const targetRelationshipValid =
      targetDocumentId === null
        ? targetPath === null && availableTokens === null && sourceBytesAvailable === null
        : targetPath === document?.path &&
          availableTokens === document.rawTokens &&
          sourceBytesAvailable === document.sourceBytes;
    if (!targetRelationshipValid) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${itemLabel} disagrees with its target document`,
      );
    }
    if (disposition === "included") {
      if (
        activation === null ||
        consumedTokens === null ||
        sourceBytesConsumed === null ||
        document === undefined ||
        availableTokens === null ||
        sourceBytesAvailable === null ||
        consumedTokens > availableTokens ||
        sourceBytesConsumed > sourceBytesAvailable ||
        truncated !== sourceBytesConsumed < sourceBytesAvailable
      ) {
        fail(
          ProfileTargetDistributionErrorCode.invalidRelationship,
          `${itemLabel} has invalid included evidence`,
        );
      }
      effective = safeAdd(effective, consumedTokens, "effective token total");
      if (occurrenceState !== "entry") {
        imported = safeAdd(imported, consumedTokens, "imported token total");
      }
      if (activation === "always") always = safeAdd(always, consumedTokens, "always token total");
      reachedContents.add(document.contentId);
    } else if (
      activation !== null ||
      consumedTokens !== null ||
      sourceBytesConsumed !== null ||
      truncated !== null
    ) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${itemLabel} has invalid excluded or unknown evidence`,
      );
    }
  }
  let unique = 0;
  for (const contentId of reachedContents) {
    const tokens = evidence.contentTokens.get(contentId);
    if (tokens === undefined) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        `${label} reaches unknown content`,
      );
    }
    unique = safeAdd(unique, tokens, "unique token total");
  }
  return Object.freeze({ always, effective, imported, unique });
}

function revalidateAccountingEvidence(
  accounting: DataRecord,
  totals: ReturnType<typeof normalizeTotals>,
  state: "complete" | "partial",
  label: string,
): void {
  const documentEvidence = normalizeDocumentEvidence(accounting, label);
  const occurrenceEvidence = normalizeOccurrenceEvidence(accounting, documentEvidence, label);
  const rawIssues = denseArray(
    property(accounting, "issues"),
    OCCURRENCE_TOKEN_ACCOUNTING_LIMITS.maxOccurrences,
    `${label}.issues`,
  );
  for (const [index, value] of rawIssues.entries()) {
    const itemLabel = `${label}.issues[${String(index)}]`;
    const item = dataRecord(value, ["code", "occurrenceId", "path"], itemLabel);
    const code = property(item, "code");
    if (typeof code !== "string" || !ACCOUNTING_ISSUE_CODES.has(code)) {
      fail(ProfileTargetDistributionErrorCode.invalidInput, `${itemLabel}.code is invalid`);
    }
    nullableText(property(item, "occurrenceId"), `${itemLabel}.occurrenceId`, IDENTIFIER);
    accountingIssuePath(property(item, "path"), `${itemLabel}.path`);
  }
  if ((state === "complete") !== (rawIssues.length === 0)) {
    fail(
      ProfileTargetDistributionErrorCode.invalidRelationship,
      `${label}.state disagrees with its issues`,
    );
  }
  if (
    documentEvidence.raw !== totals.raw ||
    occurrenceEvidence.imported !== totals.imported ||
    occurrenceEvidence.unique !== totals.unique ||
    occurrenceEvidence.always !== totals.always ||
    occurrenceEvidence.effective !== totals.effective
  ) {
    fail(
      ProfileTargetDistributionErrorCode.invalidRelationship,
      `${label}.totals do not reconcile with contribution evidence`,
    );
  }
}

function normalizeAccounting(
  value: unknown,
  identity: TokenizerIdentity,
  label: string,
): Omit<ProfileTargetTokenObservation, "includedInStatistics" | "path"> {
  const accounting = dataRecord(
    value,
    [
      "recordKind",
      "contractVersion",
      "contents",
      "documents",
      "identity",
      "issues",
      "occurrences",
      "state",
      "totals",
      "traceSha256",
    ],
    label,
  );
  if (property(accounting, "recordKind") !== "agent-context-occurrence-token-accounting") {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.recordKind is invalid`);
  }
  if (property(accounting, "contractVersion") !== OCCURRENCE_TOKEN_ACCOUNTING_CONTRACT_VERSION) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.contractVersion is invalid`);
  }
  const candidateIdentity = validateTokenizerIdentity(property(accounting, "identity"));
  if (!candidateIdentity.ok) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.identity is invalid`);
  }
  if (!compareTokenizerIdentities(identity, candidateIdentity.value).compatible) {
    fail(
      ProfileTargetDistributionErrorCode.incompatibleTokenizer,
      `${label}.identity is incompatible with the selected tokenizer`,
    );
  }
  const state = property(accounting, "state");
  if (state !== "complete" && state !== "partial") {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.state is invalid`);
  }
  const traceSha256 = property(accounting, "traceSha256");
  if (typeof traceSha256 !== "string" || !SHA256.test(traceSha256)) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, `${label}.traceSha256 is invalid`);
  }
  const totals = normalizeTotals(property(accounting, "totals"), `${label}.totals`);
  revalidateAccountingEvidence(accounting, totals, state, label);
  return Object.freeze({
    alwaysOnTokens: totals.always,
    effectiveTokens: totals.effective,
    state,
    traceSha256,
  });
}

/** Return the observed empirical quantile using the nearest-rank inverse ECDF. */
function nearestRank(sorted: readonly number[], numerator: 50 | 95): number {
  const index = Math.ceil((sorted.length * numerator) / 100) - 1;
  const value = sorted[index];
  if (value === undefined) {
    fail(ProfileTargetDistributionErrorCode.invalidRelationship, "percentile input is empty");
  }
  return value;
}

function requiredNumber(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    fail(ProfileTargetDistributionErrorCode.invalidRelationship, "distribution input is empty");
  }
  return value;
}

/** Aggregate one profile's E08 sample and G03 target accountings without interpolation. */
export function aggregateProfileTargetDistribution(
  inputValue: AggregateProfileTargetDistributionInput,
): ProfileTargetDistribution {
  const input = dataRecord(inputValue, ["accountings", "identity", "profile", "sampling"], "input");
  const identityResult = validateTokenizerIdentity(property(input, "identity"));
  if (!identityResult.ok) {
    fail(ProfileTargetDistributionErrorCode.invalidInput, "identity is invalid");
  }
  const identity = identityResult.value;
  const profile = normalizeProfile(property(input, "profile"));
  const sampling = normalizeSampling(property(input, "sampling"));
  const rawAccountings = denseArray(
    property(input, "accountings"),
    PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS,
    "accountings",
  );
  if (rawAccountings.length !== sampling.paths.length) {
    fail(
      ProfileTargetDistributionErrorCode.invalidRelationship,
      "accountings must contain exactly one result for every sampled target",
    );
  }
  const observations = rawAccountings
    .map((value, index) => {
      const label = `accountings[${String(index)}]`;
      const entry = dataRecord(value, ["accounting", "path"], label);
      const path = pathValue(property(entry, "path"), `${label}.path`);
      const accounting = normalizeAccounting(
        property(entry, "accounting"),
        identity,
        `${label}.accounting`,
      );
      return Object.freeze({
        ...accounting,
        includedInStatistics: accounting.state === "complete",
        path,
      });
    })
    .sort((left, right) => compareRepositoryRelativePaths(left.path, right.path));
  for (let index = 0; index < sampling.paths.length; index += 1) {
    if (observations[index]?.path !== sampling.paths[index]) {
      fail(
        ProfileTargetDistributionErrorCode.invalidRelationship,
        "accounting paths must exactly match the E08 selected target set",
      );
    }
  }
  const completeValues = observations
    .filter((observation) => observation.includedInStatistics)
    .map((observation) => observation.effectiveTokens)
    .sort((left, right) => left - right);
  const statistics =
    completeValues.length === 0
      ? null
      : Object.freeze({
          maximum: requiredNumber(completeValues, completeValues.length - 1),
          minimum: requiredNumber(completeValues, 0),
          p50: nearestRank(completeValues, 50),
          p95: nearestRank(completeValues, 95),
        });
  const issues: ProfileTargetDistributionIssue[] = [];
  if (sampling.state === "partial") {
    issues.push(Object.freeze({ code: "sampling-partial", path: null }));
  }
  for (const observation of observations) {
    if (observation.state === "partial") {
      issues.push(Object.freeze({ code: "accounting-partial", path: observation.path }));
    }
  }
  if (observations.length > 0 && completeValues.length === 0) {
    issues.push(Object.freeze({ code: "no-complete-targets", path: null }));
  }
  const state = observations.length === 0 ? "empty" : issues.length === 0 ? "complete" : "partial";
  return Object.freeze({
    completeSampleCount: completeValues.length,
    contractVersion: PROFILE_TARGET_DISTRIBUTION_CONTRACT_VERSION,
    issues: Object.freeze(issues),
    percentileMethod: PROFILE_TARGET_DISTRIBUTION_PERCENTILE_METHOD,
    profile,
    recordKind: "agent-context-profile-target-token-distribution",
    sampleCount: observations.length,
    sampling: Object.freeze({
      contractVersion: TARGET_SAMPLER_CONTRACT_VERSION,
      state: sampling.state,
      strategy: sampling.strategy,
    }),
    state,
    statistics,
    targets: Object.freeze(observations),
    tokenizer: identity,
  });
}
