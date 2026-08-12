import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath } from "@agent-context/core";

import type { RepositoryRelativePath, ResolutionEvent } from "@agent-context/core";
import { isIssuedEffectiveContextResolution } from "./effective-context.js";
import {
  ResolutionEventTraceError,
  digestResolutionEventTrace,
  normalizeResolutionEventTrace,
} from "./resolution-event-trace.js";

import type {
  EffectiveContextAmbiguity,
  EffectiveContextAssembly,
  EffectiveContextConflictOpportunity,
  EffectiveContextDocument,
  EffectiveContextOccurrence,
  EffectiveContextPrecedence,
  EffectiveContextResolution,
} from "./effective-context.js";
import type { ResolutionEventTrace } from "./resolution-event-trace.js";

export const EXPLAIN_PROJECTION_CONTRACT_VERSION = "0.1.0" as const;
export const EXPLAIN_PROJECTION_INPUT_RECORD_KIND =
  "agent-context-explain-projection-input" as const;
export const EXPLAIN_PROJECTION_RECORD_KIND = "agent-context-explain-projection" as const;

export const EXPLAIN_PROJECTION_LIMITS: Readonly<{
  maximumAggregateDocuments: number;
  maximumAggregateOccurrences: number;
  maximumAggregateReasons: number;
  maximumAggregateTraceEvents: number;
  maximumTargets: number;
}> = Object.freeze({
  maximumAggregateDocuments: 8_192,
  maximumAggregateOccurrences: 32_768,
  maximumAggregateReasons: 65_536,
  maximumAggregateTraceEvents: 65_536,
  maximumTargets: 4_096,
});

export interface ProjectExplainInput {
  readonly contractVersion: typeof EXPLAIN_PROJECTION_CONTRACT_VERSION;
  readonly recordKind: typeof EXPLAIN_PROJECTION_INPUT_RECORD_KIND;
  readonly resolutions: readonly EffectiveContextResolution[];
  /** Parsed E03 JSON supplied by `--trace`, or null for a static target projection. */
  readonly trace: unknown;
}

export type ExplainDisposition = "conditional" | "excluded" | "included";

export type ExplainReasonKind =
  "activation" | "ambiguity" | "content" | "import" | "selection" | "truncation";

export interface ExplainReason {
  readonly code: string;
  readonly kind: ExplainReasonKind;
  readonly relatedId: string | null;
  readonly sourceCode: string | null;
}

export interface ExplainDocument {
  readonly activation: EffectiveContextDocument["activation"];
  readonly availableBytes: number | null;
  readonly contentSha256: string | null;
  readonly contentState: EffectiveContextDocument["contentState"];
  readonly disposition: ExplainDisposition;
  readonly formatId: string;
  readonly id: string;
  readonly includedBytes: number | null;
  readonly order: number | null;
  readonly path: RepositoryRelativePath;
  readonly reasons: readonly ExplainReason[];
  readonly sourceDocumentId: string | null;
  readonly state: EffectiveContextDocument["state"];
  readonly text: string | null;
  readonly truncation: EffectiveContextDocument["truncation"];
}

export interface ExplainOccurrence {
  readonly contentId: string | null;
  readonly disposition: ExplainDisposition;
  readonly entryDocumentId: string;
  readonly id: string;
  readonly ordinal: number;
  readonly reasons: readonly ExplainReason[];
  readonly state: EffectiveContextOccurrence["state"];
  readonly targetDocumentId: string | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export interface ExplainTraceEvent {
  readonly id: string;
  readonly kind: ResolutionEvent["kind"];
  readonly path: RepositoryRelativePath | null;
  readonly scope: "session" | "target";
  readonly sequence: number;
  readonly targetId: string | null;
  readonly uncertainty: ResolutionEvent["uncertainty"]["state"];
}

export interface ExplainAccounting {
  readonly ambiguities: number;
  readonly conflicts: number;
  readonly documents: Readonly<Record<ExplainDisposition | "total", number>>;
  readonly occurrences: Readonly<Record<ExplainDisposition | "total", number>>;
  readonly reasons: number;
  readonly traceEvents: number;
}

export interface ExplainTargetProjection {
  readonly accounting: ExplainAccounting;
  readonly ambiguities: readonly EffectiveContextAmbiguity[];
  readonly analysisStatus: "complete" | "partial";
  readonly assembly: EffectiveContextAssembly;
  readonly conflicts: readonly EffectiveContextConflictOpportunity[];
  readonly documents: readonly ExplainDocument[];
  readonly occurrences: readonly ExplainOccurrence[];
  readonly ordering: EffectiveContextResolution["ordering"];
  readonly precedence: readonly EffectiveContextPrecedence[];
  readonly sequence: readonly string[];
  readonly targetPath: RepositoryRelativePath;
  readonly traceEvents: readonly ExplainTraceEvent[];
  readonly traceTargetIds: readonly string[];
}

export interface ExplainProjection {
  readonly analysisStatus: "complete" | "partial";
  readonly clientVersion: string | null;
  readonly contractVersion: typeof EXPLAIN_PROJECTION_CONTRACT_VERSION;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly recordKind: typeof EXPLAIN_PROJECTION_RECORD_KIND;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
  readonly targets: readonly ExplainTargetProjection[];
  readonly trace: {
    readonly binding: "not-applicable" | "target-matched";
    readonly eventCount: number;
    readonly mode: "provided" | "static";
    readonly sha256: string | null;
    readonly targetCount: number;
  };
}

export const ExplainProjectionErrorCode: Readonly<{
  invalidInput: "EXPLAIN_PROJECTION_INVALID_INPUT";
  invalidRelationship: "EXPLAIN_PROJECTION_INVALID_RELATIONSHIP";
  invalidTrace: "EXPLAIN_PROJECTION_INVALID_TRACE";
  resourceLimit: "EXPLAIN_PROJECTION_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "EXPLAIN_PROJECTION_INVALID_INPUT",
  invalidRelationship: "EXPLAIN_PROJECTION_INVALID_RELATIONSHIP",
  invalidTrace: "EXPLAIN_PROJECTION_INVALID_TRACE",
  resourceLimit: "EXPLAIN_PROJECTION_RESOURCE_LIMIT",
});

export type ExplainProjectionErrorCode =
  (typeof ExplainProjectionErrorCode)[keyof typeof ExplainProjectionErrorCode];

export class ExplainProjectionError extends Error {
  readonly code: ExplainProjectionErrorCode;
  override readonly name = "ExplainProjectionError" as const;

  constructor(code: ExplainProjectionErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Budget {
  documents: number;
  occurrences: number;
  reasons: number;
  traceEvents: number;
}

const INPUT_KEYS = new Set(["contractVersion", "recordKind", "resolutions", "trace"]);
const INCLUDED_OCCURRENCES = new Set(["already-loaded", "entry", "loaded"]);

function fail(code: ExplainProjectionErrorCode, message: string): never {
  throw new ExplainProjectionError(code, message);
}

function dataRecord(value: unknown, label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    (Reflect.getPrototypeOf(value) !== Object.prototype && Reflect.getPrototypeOf(value) !== null)
  )
    return fail(
      ExplainProjectionErrorCode.invalidInput,
      `${label} must be a non-proxy data record`,
    );
  return value as DataRecord;
}

function property(record: DataRecord, key: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
    return fail(
      ExplainProjectionErrorCode.invalidInput,
      `${label}.${key} must be an own data field`,
    );
  return descriptor.value;
}

function closedInput(value: unknown): DataRecord {
  const record = dataRecord(value, "input");
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== INPUT_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))
  )
    return fail(ExplainProjectionErrorCode.invalidInput, "input has missing or unknown fields");
  for (const key of keys) property(record, key as string, "input");
  return record;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(ExplainProjectionErrorCode.invalidInput, `${label} must be a regular dense array`);
  if (value.length > maximum)
    return fail(ExplainProjectionErrorCode.resourceLimit, `${label} exceeds its item limit`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(ExplainProjectionErrorCode.invalidInput, `${label} must not be sparse or extended`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(ExplainProjectionErrorCode.invalidInput, `${label} contains an unsafe entry`);
  }
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function addReason(
  output: ExplainReason[],
  budget: Budget,
  kind: ExplainReasonKind,
  code: string,
  sourceCode: string | null,
  relatedId: string | null = null,
): void {
  budget.reasons += 1;
  if (budget.reasons > EXPLAIN_PROJECTION_LIMITS.maximumAggregateReasons)
    return fail(
      ExplainProjectionErrorCode.resourceLimit,
      "aggregate reason count exceeds its limit",
    );
  output.push(Object.freeze({ code, kind, relatedId, sourceCode }));
}

function documentDisposition(document: EffectiveContextDocument): ExplainDisposition {
  if (document.activation === "indeterminate" || document.state === "conditional")
    return "conditional";
  if (
    document.activation === "inactive" ||
    document.state === "inactive" ||
    document.state === "shadowed"
  )
    return "excluded";
  return "included";
}

function documentReasons(
  document: EffectiveContextDocument,
  ambiguities: readonly EffectiveContextAmbiguity[],
  budget: Budget,
): readonly ExplainReason[] {
  const output: ExplainReason[] = [];
  addReason(output, budget, "activation", `activation-${document.activation}`, document.reasonCode);
  addReason(output, budget, "selection", `state-${document.state}`, document.reasonCode);
  addReason(output, budget, "content", `content-${document.contentState}`, null);
  if (document.truncation !== "none")
    addReason(output, budget, "truncation", `truncation-${document.truncation}`, null);
  for (const ambiguity of ambiguities)
    if (ambiguity.documentIds.includes(document.id))
      addReason(
        output,
        budget,
        "ambiguity",
        `ambiguity-${ambiguity.kind}`,
        ambiguity.reasonCode,
        ambiguity.id,
      );
  return Object.freeze(output);
}

function projectDocument(
  document: EffectiveContextDocument,
  ambiguities: readonly EffectiveContextAmbiguity[],
  budget: Budget,
): ExplainDocument {
  budget.documents += 1;
  if (budget.documents > EXPLAIN_PROJECTION_LIMITS.maximumAggregateDocuments)
    return fail(
      ExplainProjectionErrorCode.resourceLimit,
      "aggregate explained document count exceeds its limit",
    );
  return Object.freeze({
    activation: document.activation,
    availableBytes: document.availableBytes,
    contentSha256: document.contentSha256,
    contentState: document.contentState,
    disposition: documentDisposition(document),
    formatId: document.formatId,
    id: document.id,
    includedBytes: document.includedBytes,
    order: document.order,
    path: document.path,
    reasons: documentReasons(document, ambiguities, budget),
    sourceDocumentId: document.sourceDocumentId,
    state: document.state,
    text: document.text,
    truncation: document.truncation,
  });
}

function occurrenceDisposition(occurrence: EffectiveContextOccurrence): ExplainDisposition {
  if (occurrence.state === "ambiguous") return "conditional";
  return INCLUDED_OCCURRENCES.has(occurrence.state) ? "included" : "excluded";
}

function projectOccurrence(
  occurrence: EffectiveContextOccurrence,
  budget: Budget,
): ExplainOccurrence {
  budget.occurrences += 1;
  if (budget.occurrences > EXPLAIN_PROJECTION_LIMITS.maximumAggregateOccurrences)
    return fail(
      ExplainProjectionErrorCode.resourceLimit,
      "aggregate explained occurrence count exceeds its limit",
    );
  const reasons: ExplainReason[] = [];
  addReason(
    reasons,
    budget,
    "import",
    `import-${occurrence.state}`,
    occurrence.issueCode,
    occurrence.id,
  );
  return Object.freeze({
    contentId: occurrence.contentId,
    disposition: occurrenceDisposition(occurrence),
    entryDocumentId: occurrence.entryDocumentId,
    id: occurrence.id,
    ordinal: occurrence.ordinal,
    reasons: Object.freeze(reasons),
    state: occurrence.state,
    targetDocumentId: occurrence.targetDocumentId,
    targetPath: occurrence.targetPath,
  });
}

function normalizeTrace(value: unknown): ResolutionEventTrace | null {
  if (value === null) return null;
  try {
    return normalizeResolutionEventTrace(value);
  } catch (error) {
    if (error instanceof ResolutionEventTraceError)
      return fail(ExplainProjectionErrorCode.invalidTrace, "provided trace failed E03 validation");
    return fail(ExplainProjectionErrorCode.invalidTrace, "provided trace could not be validated");
  }
}

function eventPath(event: ResolutionEvent): RepositoryRelativePath | null {
  return "path" in event ? event.path : null;
}

function traceForTarget(
  trace: ResolutionEventTrace | null,
  targetPath: RepositoryRelativePath,
  budget: Budget,
): { readonly events: readonly ExplainTraceEvent[]; readonly targetIds: readonly string[] } {
  if (trace === null) return { events: Object.freeze([]), targetIds: Object.freeze([]) };
  const targetIds = trace.targets
    .filter((target) => target.path === targetPath)
    .map((target) => target.id)
    .sort(compareUtf8);
  if (targetIds.length === 0)
    return fail(
      ExplainProjectionErrorCode.invalidRelationship,
      "every explained target must occur in the provided trace",
    );
  const targetSet = new Set<string>(targetIds);
  const relevant = trace.events.filter(
    (event) => event.kind === "launch" || event.targetId === null || targetSet.has(event.targetId),
  );
  budget.traceEvents += relevant.length;
  if (budget.traceEvents > EXPLAIN_PROJECTION_LIMITS.maximumAggregateTraceEvents)
    return fail(
      ExplainProjectionErrorCode.resourceLimit,
      "aggregate explained trace-event count exceeds its limit",
    );
  const events = relevant.map((event): ExplainTraceEvent =>
    Object.freeze({
      id: event.id,
      kind: event.kind,
      path: eventPath(event),
      scope:
        event.kind === "launch" || event.targetId === null || !targetSet.has(event.targetId)
          ? "session"
          : "target",
      sequence: event.sequence,
      targetId: event.targetId,
      uncertainty: event.uncertainty.state,
    }),
  );
  return { events: Object.freeze(events), targetIds: Object.freeze(targetIds) };
}

function countDispositions(
  entries: readonly { readonly disposition: ExplainDisposition }[],
): Readonly<Record<ExplainDisposition | "total", number>> {
  let conditional = 0;
  let excluded = 0;
  let included = 0;
  for (const entry of entries) {
    if (entry.disposition === "conditional") conditional += 1;
    else if (entry.disposition === "excluded") excluded += 1;
    else included += 1;
  }
  return Object.freeze({ conditional, excluded, included, total: entries.length });
}

function targetProjection(
  resolution: EffectiveContextResolution,
  trace: ResolutionEventTrace | null,
  budget: Budget,
): ExplainTargetProjection {
  const documents = resolution.documents.map((document) =>
    projectDocument(document, resolution.ambiguities, budget),
  );
  const occurrences = resolution.occurrences.map((occurrence) =>
    projectOccurrence(occurrence, budget),
  );
  const projectedTrace = traceForTarget(trace, resolution.targetPath, budget);
  const reasonCount =
    documents.reduce((total, document) => total + document.reasons.length, 0) +
    occurrences.reduce((total, occurrence) => total + occurrence.reasons.length, 0);
  return Object.freeze({
    accounting: Object.freeze({
      ambiguities: resolution.ambiguities.length,
      conflicts: resolution.conflicts.length,
      documents: countDispositions(documents),
      occurrences: countDispositions(occurrences),
      reasons: reasonCount,
      traceEvents: projectedTrace.events.length,
    }),
    ambiguities: resolution.ambiguities,
    analysisStatus: resolution.analysisStatus,
    assembly: resolution.assembly,
    conflicts: resolution.conflicts,
    documents: Object.freeze(documents),
    occurrences: Object.freeze(occurrences),
    ordering: resolution.ordering,
    precedence: resolution.precedence,
    sequence: resolution.sequence,
    targetPath: resolution.targetPath,
    traceEvents: projectedTrace.events,
    traceTargetIds: projectedTrace.targetIds,
  });
}

function identity(resolution: EffectiveContextResolution): string {
  return [
    resolution.profileId,
    resolution.profileVersion,
    resolution.clientVersion ?? "",
    resolution.surfaceId,
    resolution.specSnapshotId,
  ].join("\u0000");
}

/**
 * Produce an immutable, deterministic explanation for one or many already-resolved targets.
 * A supplied E03 trace is target-matched evidence; E06 never reruns a profile or performs I/O.
 */
export function projectExplain(rawInput: unknown): ExplainProjection {
  const input = closedInput(rawInput);
  if (
    property(input, "recordKind", "input") !== EXPLAIN_PROJECTION_INPUT_RECORD_KIND ||
    property(input, "contractVersion", "input") !== EXPLAIN_PROJECTION_CONTRACT_VERSION
  )
    return fail(ExplainProjectionErrorCode.invalidInput, "input kind or version is invalid");
  const values = denseArray(
    property(input, "resolutions", "input"),
    EXPLAIN_PROJECTION_LIMITS.maximumTargets,
    "input.resolutions",
  );
  if (values.length === 0)
    return fail(
      ExplainProjectionErrorCode.invalidInput,
      "at least one target resolution is required",
    );
  const resolutions: EffectiveContextResolution[] = [];
  for (const value of values) {
    if (!isIssuedEffectiveContextResolution(value))
      return fail(
        ExplainProjectionErrorCode.invalidInput,
        "every resolution must be issued by E05 in this process",
      );
    resolutions.push(value);
  }
  const first = resolutions.at(0);
  if (first === undefined)
    return fail(
      ExplainProjectionErrorCode.invalidInput,
      "at least one target resolution is required",
    );
  const expectedIdentity = identity(first);
  if (resolutions.some((resolution) => identity(resolution) !== expectedIdentity))
    return fail(
      ExplainProjectionErrorCode.invalidRelationship,
      "one explanation cannot combine incompatible profile identities",
    );
  const paths = new Set<string>();
  for (const resolution of resolutions) {
    if (!isRepositoryRelativePath(resolution.targetPath) || paths.has(resolution.targetPath))
      return fail(
        ExplainProjectionErrorCode.invalidRelationship,
        "target resolutions must have unique canonical paths",
      );
    paths.add(resolution.targetPath);
  }
  const trace = normalizeTrace(property(input, "trace", "input"));
  resolutions.sort((left, right) => compareUtf8(left.targetPath, right.targetPath));
  const budget: Budget = { documents: 0, occurrences: 0, reasons: 0, traceEvents: 0 };
  const targets = Object.freeze(
    resolutions.map((resolution) => targetProjection(resolution, trace, budget)),
  );
  return Object.freeze({
    analysisStatus: targets.every((target) => target.analysisStatus === "complete")
      ? "complete"
      : "partial",
    clientVersion: first.clientVersion,
    contractVersion: EXPLAIN_PROJECTION_CONTRACT_VERSION,
    profileId: first.profileId,
    profileVersion: first.profileVersion,
    recordKind: EXPLAIN_PROJECTION_RECORD_KIND,
    specSnapshotId: first.specSnapshotId,
    surfaceId: first.surfaceId,
    targets,
    trace: Object.freeze({
      binding: trace === null ? "not-applicable" : "target-matched",
      eventCount: trace?.events.length ?? 0,
      mode: trace === null ? "static" : "provided",
      sha256: trace === null ? null : digestResolutionEventTrace(trace),
      targetCount: trace?.targets.length ?? 0,
    }),
  });
}
