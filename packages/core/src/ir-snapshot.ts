import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { MAX_VALIDATION_ISSUES } from "./contract-validation.js";
import { INSTRUCTION_IR_CONTRACT_VERSION } from "./ir-contracts.js";
import { validateInstructionIr } from "./ir-validation.js";

import type { InstructionIr, InstructionIrValidationIssue } from "./ir-contracts.js";

export const INSTRUCTION_IR_SNAPSHOT_CONTRACT_VERSION = "0.1.0" as const;

export interface InstructionIrSnapshotLimits {
  readonly maximumActivationConditions: number;
  readonly maximumActivationEvidenceRefs: number;
  readonly maximumActivationRules: number;
  readonly maximumActivationSelectors: number;
  readonly maximumConditionsPerActivationRule: number;
  readonly maximumContainerEntries: number;
  readonly maximumDocuments: number;
  readonly maximumEventJsonValues: number;
  readonly maximumEvents: number;
  readonly maximumEvidenceRefsPerActivationRule: number;
  readonly maximumImports: number;
  readonly maximumJsonValues: number;
  readonly maximumKeyBytes: number;
  readonly maximumNodeChildReferences: number;
  readonly maximumNodes: number;
  readonly maximumSelectedRulesPerEvent: number;
  readonly maximumSelectorsPerActivationRule: number;
  readonly maximumSettingsPerEvent: number;
  readonly maximumSourceUtf16CodeUnits: number;
  readonly maximumSourceUtf8Bytes: number;
  readonly maximumSources: number;
  readonly maximumStatementNodeReferences: number;
  readonly maximumStatements: number;
  readonly maximumStringBytes: number;
  readonly maximumTargets: number;
  readonly maximumTotalSourceUtf16CodeUnits: number;
  readonly maximumTotalSourceUtf8Bytes: number;
  readonly maximumTotalStringBytes: number;
  readonly maximumWorkspaceRootsPerEvent: number;
}

/**
 * Non-configurable admission ceilings for the engine-owned B03 snapshot. They align with the
 * strictest downstream parser/rule mechanism used by a complete static scan. Callers cannot widen
 * them by supplying options.
 */
export const INSTRUCTION_IR_SNAPSHOT_LIMITS: Readonly<InstructionIrSnapshotLimits> = Object.freeze({
  maximumActivationConditions: 65_536,
  maximumActivationEvidenceRefs: 65_536,
  maximumActivationRules: 4_096,
  maximumActivationSelectors: 65_536,
  maximumConditionsPerActivationRule: 1_024,
  maximumContainerEntries: 100_000,
  maximumDocuments: 4_096,
  maximumEventJsonValues: 65_536,
  maximumEvents: 16_384,
  maximumEvidenceRefsPerActivationRule: 4_096,
  maximumImports: 50_000,
  maximumJsonValues: 4_000_000,
  maximumKeyBytes: 1_024,
  maximumNodeChildReferences: 50_000,
  maximumNodes: 50_000,
  maximumSelectedRulesPerEvent: 4_096,
  maximumSelectorsPerActivationRule: 4_096,
  maximumSettingsPerEvent: 4_096,
  maximumSourceUtf16CodeUnits: 524_288,
  maximumSourceUtf8Bytes: 524_288,
  maximumSources: 1_024,
  maximumStatementNodeReferences: 1_000_000,
  maximumStatements: 100_000,
  maximumStringBytes: 1_048_576,
  maximumTargets: 4_096,
  maximumTotalSourceUtf16CodeUnits: 16_777_216,
  maximumTotalSourceUtf8Bytes: 16_777_216,
  maximumTotalStringBytes: 67_108_864,
  maximumWorkspaceRootsPerEvent: 4_096,
});

declare const instructionIrSnapshotBrand: unique symbol;

/** A detached, recursively frozen B03 graph admitted and issued by this process. */
export type InstructionIrSnapshot = InstructionIr & {
  readonly [instructionIrSnapshotBrand]: "InstructionIrSnapshot";
};

export interface InstructionIrSnapshotCounts {
  readonly activationRules: number;
  readonly documents: number;
  readonly events: number;
  readonly imports: number;
  readonly nodes: number;
  readonly sources: number;
  readonly statements: number;
  readonly targets: number;
}

export interface InstructionIrSnapshotUsage {
  readonly jsonStringBytes: number;
  readonly jsonValues: number;
  readonly sourceUtf16CodeUnits: number;
  readonly sourceUtf8Bytes: number;
}

export interface InstructionIrSnapshotProvenance {
  readonly algorithm: "sha256-canonical-b03-v1";
  readonly contractVersion: typeof INSTRUCTION_IR_SNAPSHOT_CONTRACT_VERSION;
  readonly counts: InstructionIrSnapshotCounts;
  readonly digest: string;
  readonly instructionIrContractVersion: typeof INSTRUCTION_IR_CONTRACT_VERSION;
  readonly recordKind: "agent-context-instruction-ir-snapshot-provenance";
  readonly usage: InstructionIrSnapshotUsage;
}

export type InstructionIrSnapshotResult =
  | {
      readonly ok: true;
      readonly provenance: InstructionIrSnapshotProvenance;
      readonly value: InstructionIrSnapshot;
    }
  | { readonly issues: readonly InstructionIrValidationIssue[]; readonly ok: false };

interface TraversalUsage {
  stringBytes: number;
  values: number;
}

interface MemoizedClone {
  readonly copy: object;
  usage?: Readonly<TraversalUsage>;
}

class SnapshotFailure extends Error {
  readonly issue: InstructionIrValidationIssue;

  constructor(issue: InstructionIrValidationIssue) {
    super(issue.message);
    this.name = "SnapshotFailure";
    this.issue = issue;
  }
}

const COLLECTION_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  activationRules: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationRules,
  documents: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumDocuments,
  events: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEvents,
  imports: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumImports,
  nodes: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumNodes,
  sources: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSources,
  statements: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStatements,
  targets: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumTargets,
});
const SNAPSHOT_PROVENANCE = new WeakMap<object, InstructionIrSnapshotProvenance>();
const MAX_JSON_NESTING_DEPTH = 256;

function issue(
  code: InstructionIrValidationIssue["code"],
  path: string,
  message: string,
): InstructionIrValidationIssue {
  return Object.freeze({ code, message, path });
}

function fail(code: InstructionIrValidationIssue["code"], path: string, message: string): never {
  throw new SnapshotFailure(issue(code, path, message));
}

function malformed(path: string, message: string): never {
  return fail("invalid-json", path, message);
}

function resource(path: string, message: string): never {
  return fail("resource-limit", path, message);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function inspectedArrayLength(value: object, path: string, maximum: number): number {
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Reflect.getPrototypeOf(value);
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  } catch {
    return malformed(path, "must be safely inspectable JSON data");
  }
  if (prototype !== Array.prototype) malformed(path, "must be a plain JSON array");
  const length = lengthDescriptor?.value as unknown;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
    malformed(path, "must expose a canonical array length");
  if (length > maximum) resource(path, `must not contain more than ${String(maximum)} entries`);
  return length;
}

/** Reject oversized root collections before enumerating a hostile array's own keys. */
function preflightRootCollections(value: unknown): void {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value))
    malformed("$", "must be a non-proxy JSON object");
  let prototype: object | null;
  try {
    if (Array.isArray(value)) malformed("$", "must be a JSON object");
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    return malformed("$", "must be safely inspectable JSON data");
  }
  if (prototype !== Object.prototype && prototype !== null)
    malformed("$", "must be a plain JSON object");
  for (const [key, maximum] of Object.entries(COLLECTION_LIMITS)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return malformed("$", "must be safely inspectable JSON data");
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) continue;
    const collection: unknown = descriptor.value;
    if (collection === null || typeof collection !== "object" || nodeTypes.isProxy(collection))
      continue;
    if (Array.isArray(collection)) inspectedArrayLength(collection, `$.${key}`, maximum);
  }
}

function addUsage(usage: TraversalUsage, addition: Readonly<TraversalUsage>, path: string): void {
  usage.values += addition.values;
  usage.stringBytes += addition.stringBytes;
  if (usage.values > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumJsonValues)
    resource(path, "JSON value count exceeds the instruction IR snapshot limit");
  if (usage.stringBytes > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumTotalStringBytes)
    resource(path, "cumulative JSON string bytes exceed the instruction IR snapshot limit");
}

function inspectString(
  value: string,
  path: string,
  maximumBytes: number,
  usage: TraversalUsage,
): void {
  if (value.length > maximumBytes)
    resource(path, `must not exceed ${String(maximumBytes)} UTF-8 bytes`);
  if (!isWellFormedUnicode(value)) malformed(path, "must be well-formed Unicode");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) resource(path, `must not exceed ${String(maximumBytes)} UTF-8 bytes`);
  addUsage(usage, { stringBytes: bytes, values: 0 }, path);
}

function cloneJsonValue(
  value: unknown,
): Readonly<{ readonly usage: TraversalUsage; value: unknown }> {
  const ancestors = new WeakSet<object>();
  const memo = new WeakMap<object, MemoizedClone>();
  const usage: TraversalUsage = { stringBytes: 0, values: 0 };

  const visit = (candidate: unknown, path: string, depth: number): unknown => {
    if (candidate !== null && typeof candidate === "object") {
      if (nodeTypes.isProxy(candidate)) malformed(path, "proxies are not JSON data");
      if (ancestors.has(candidate)) malformed(path, "must not contain a reference cycle");
      const prior = memo.get(candidate);
      if (prior?.usage !== undefined) {
        addUsage(usage, prior.usage, path);
        return prior.copy;
      }
    }

    const startValues = usage.values;
    const startBytes = usage.stringBytes;
    addUsage(usage, { stringBytes: 0, values: 1 }, path);
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      inspectString(candidate, path, INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStringBytes, usage);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0))
        malformed(path, "must be a finite JSON number other than negative zero");
      return candidate;
    }
    if (typeof candidate !== "object") malformed(path, "must be a JSON value");
    if (depth >= MAX_JSON_NESTING_DEPTH)
      malformed(path, `must not exceed ${String(MAX_JSON_NESTING_DEPTH)} nested JSON containers`);

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const length = inspectedArrayLength(
          candidate,
          path,
          INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumContainerEntries,
        );
        const output: unknown[] = new Array(length);
        const state: MemoizedClone = { copy: output };
        memo.set(candidate, state);
        let keys: readonly PropertyKey[];
        try {
          keys = Reflect.ownKeys(candidate);
        } catch {
          return malformed(path, "must be safely inspectable JSON data");
        }
        if (keys.length !== length + 1) malformed(path, "must be a dense unextended JSON array");
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))
            malformed(path, "array properties must be canonical in-range indices");
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length)
            malformed(`${path}.${key}`, "array property is outside the declared length");
          inspectString(key, path, INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumKeyBytes, usage);
          const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
            malformed(`${path}[${key}]`, "array entries must be enumerable own data properties");
          output[index] = visit(descriptor.value, `${path}[${key}]`, depth + 1);
        }
        for (let index = 0; index < length; index += 1) {
          if (!Object.hasOwn(output, index)) malformed(path, "must be a dense JSON array");
        }
        state.usage = Object.freeze({
          stringBytes: usage.stringBytes - startBytes,
          values: usage.values - startValues,
        });
        return output;
      }

      let prototype: object | null;
      let keys: readonly PropertyKey[];
      try {
        prototype = Reflect.getPrototypeOf(candidate);
        keys = Reflect.ownKeys(candidate);
      } catch {
        return malformed(path, "must be safely inspectable JSON data");
      }
      if (prototype !== Object.prototype && prototype !== null)
        malformed(path, "must be a plain JSON object");
      if (keys.length > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumContainerEntries)
        resource(path, "object property count exceeds the instruction IR snapshot limit");
      const output: Record<string, unknown> = {};
      const state: MemoizedClone = { copy: output };
      memo.set(candidate, state);
      for (const key of keys) {
        if (typeof key !== "string") malformed(path, "symbol keys are not JSON data");
        inspectString(key, path, INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumKeyBytes, usage);
        const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          malformed(`${path}.${key}`, "object fields must be enumerable own data properties");
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          writable: true,
        });
      }
      state.usage = Object.freeze({
        stringBytes: usage.stringBytes - startBytes,
        values: usage.values - startValues,
      });
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return { usage, value: visit(value, "$", 0) };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function enforceAggregateLimits(value: unknown): Readonly<{
  readonly sourceUtf16CodeUnits: number;
  readonly sourceUtf8Bytes: number;
}> {
  const root = recordOf(value);
  if (root === undefined) return { sourceUtf16CodeUnits: 0, sourceUtf8Bytes: 0 };
  let sourceUtf16CodeUnits = 0;
  let sourceUtf8Bytes = 0;
  const sources = Array.isArray(root["sources"]) ? root["sources"] : [];
  for (const [index, sourceValue] of sources.entries()) {
    const source = recordOf(sourceValue);
    const text = source?.["text"];
    if (typeof text !== "string") continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (text.length > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSourceUtf16CodeUnits)
      resource(
        `$.sources[${String(index)}].text`,
        "source UTF-16 length exceeds the instruction IR snapshot limit",
      );
    if (bytes > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSourceUtf8Bytes)
      resource(
        `$.sources[${String(index)}].text`,
        "source UTF-8 length exceeds the instruction IR snapshot limit",
      );
    sourceUtf16CodeUnits += text.length;
    sourceUtf8Bytes += bytes;
    if (sourceUtf16CodeUnits > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumTotalSourceUtf16CodeUnits)
      resource(
        `$.sources[${String(index)}].text`,
        "aggregate source UTF-16 length exceeds the instruction IR snapshot limit",
      );
    if (sourceUtf8Bytes > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumTotalSourceUtf8Bytes)
      resource(
        `$.sources[${String(index)}].text`,
        "aggregate source UTF-8 length exceeds the instruction IR snapshot limit",
      );
  }

  let childReferences = 0;
  const nodes = Array.isArray(root["nodes"]) ? root["nodes"] : [];
  for (const [index, nodeValue] of nodes.entries()) {
    const node = recordOf(nodeValue);
    childReferences += arrayLength(node?.["childIds"]);
    if (childReferences > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumNodeChildReferences)
      resource(
        `$.nodes[${String(index)}].childIds`,
        "AST child reference count exceeds the instruction IR snapshot limit",
      );
  }

  let statementNodeReferences = 0;
  const statements = Array.isArray(root["statements"]) ? root["statements"] : [];
  for (const [index, statementValue] of statements.entries()) {
    const statement = recordOf(statementValue);
    statementNodeReferences += arrayLength(statement?.["nodeIds"]);
    if (statementNodeReferences > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStatementNodeReferences)
      resource(
        `$.statements[${String(index)}].nodeIds`,
        "statement node reference count exceeds the instruction IR snapshot limit",
      );
  }

  let selectorCount = 0;
  let conditionCount = 0;
  let evidenceCount = 0;
  const activations = Array.isArray(root["activationRules"]) ? root["activationRules"] : [];
  for (const [index, activationValue] of activations.entries()) {
    const activation = recordOf(activationValue);
    const includeCount = arrayLength(activation?.["include"]);
    const excludeCount = arrayLength(activation?.["exclude"]);
    const perRuleSelectors = includeCount + excludeCount;
    const conditions = arrayLength(activation?.["conditions"]);
    const evidence = arrayLength(activation?.["evidenceRefs"]);
    if (perRuleSelectors > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSelectorsPerActivationRule)
      resource(
        `$.activationRules[${String(index)}]`,
        "activation selector count exceeds the per-rule snapshot limit",
      );
    if (conditions > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumConditionsPerActivationRule)
      resource(
        `$.activationRules[${String(index)}].conditions`,
        "activation condition count exceeds the per-rule snapshot limit",
      );
    if (evidence > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEvidenceRefsPerActivationRule)
      resource(
        `$.activationRules[${String(index)}].evidenceRefs`,
        "activation evidence count exceeds the per-rule snapshot limit",
      );
    selectorCount += perRuleSelectors;
    conditionCount += conditions;
    evidenceCount += evidence;
    if (selectorCount > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationSelectors)
      resource(
        `$.activationRules[${String(index)}]`,
        "aggregate activation selector count exceeds the snapshot limit",
      );
    if (conditionCount > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationConditions)
      resource(
        `$.activationRules[${String(index)}].conditions`,
        "aggregate activation condition count exceeds the snapshot limit",
      );
    if (evidenceCount > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationEvidenceRefs)
      resource(
        `$.activationRules[${String(index)}].evidenceRefs`,
        "aggregate activation evidence count exceeds the snapshot limit",
      );
  }

  let eventJsonValues = 0;
  const events = Array.isArray(root["events"]) ? root["events"] : [];
  const countJsonValues = (candidate: unknown): void => {
    eventJsonValues += 1;
    if (eventJsonValues > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEventJsonValues)
      resource("$.events", "event JSON value count exceeds the instruction IR snapshot limit");
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) countJsonValues(child);
      return;
    }
    for (const child of Object.values(candidate)) countJsonValues(child);
  };
  for (const [index, eventValue] of events.entries()) {
    const event = recordOf(eventValue);
    if (event === undefined) continue;
    const workspaceRoots = arrayLength(event["workspaceRoots"]);
    const settings = arrayLength(event["settings"]);
    const selectedRules = arrayLength(event["ruleIds"]);
    if (workspaceRoots > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumWorkspaceRootsPerEvent)
      resource(
        `$.events[${String(index)}].workspaceRoots`,
        "workspace-root count exceeds the per-event snapshot limit",
      );
    if (settings > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSettingsPerEvent)
      resource(
        `$.events[${String(index)}].settings`,
        "setting count exceeds the per-event snapshot limit",
      );
    if (selectedRules > INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSelectedRulesPerEvent)
      resource(
        `$.events[${String(index)}].ruleIds`,
        "selected-rule count exceeds the per-event snapshot limit",
      );
    if (Array.isArray(event["settings"])) {
      for (const settingValue of event["settings"]) {
        const setting = recordOf(settingValue);
        if (setting !== undefined) countJsonValues(setting["value"]);
      }
    }
  }
  return { sourceUtf16CodeUnits, sourceUtf8Bytes };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const child: unknown = descriptor.value;
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function updateLength(hash: ReturnType<typeof createHash>, value: number): void {
  hash.update(String(value), "ascii");
  hash.update(":", "ascii");
}

function canonicalDigest(value: unknown): string {
  const hash = createHash("sha256");
  hash.update("agent-context-instruction-ir-snapshot\0sha256-canonical-b03-v1\0", "utf8");
  const write = (candidate: unknown): void => {
    if (candidate === null) {
      hash.update("n", "ascii");
      return;
    }
    if (typeof candidate === "boolean") {
      hash.update(candidate ? "t" : "f", "ascii");
      return;
    }
    if (typeof candidate === "number") {
      const encoded = JSON.stringify(candidate);
      hash.update("d", "ascii");
      updateLength(hash, Buffer.byteLength(encoded, "utf8"));
      hash.update(encoded, "utf8");
      return;
    }
    if (typeof candidate === "string") {
      hash.update("s", "ascii");
      updateLength(hash, Buffer.byteLength(candidate, "utf8"));
      hash.update(candidate, "utf8");
      return;
    }
    if (Array.isArray(candidate)) {
      hash.update("a", "ascii");
      updateLength(hash, candidate.length);
      for (const child of candidate) write(child);
      return;
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record)
      .map((key) => ({ bytes: Buffer.from(key, "utf8"), key }))
      .sort((left, right) => Buffer.compare(left.bytes, right.bytes));
    hash.update("o", "ascii");
    updateLength(hash, keys.length);
    for (const { bytes, key } of keys) {
      hash.update("k", "ascii");
      updateLength(hash, bytes.length);
      hash.update(bytes);
      write(record[key]);
    }
  };
  write(value);
  return hash.digest("hex");
}

function immutableIssues(
  issues: readonly InstructionIrValidationIssue[],
): readonly InstructionIrValidationIssue[] {
  return Object.freeze(
    issues
      .slice(0, MAX_VALIDATION_ISSUES)
      .map((entry) =>
        Object.freeze({ code: entry.code, message: entry.message, path: entry.path }),
      ),
  );
}

function failure(
  issues: readonly InstructionIrValidationIssue[],
): Extract<InstructionIrSnapshotResult, { readonly ok: false }> {
  return Object.freeze({ issues: immutableIssues(issues), ok: false });
}

/**
 * Admit an untrusted B03 graph into the engine. The raw value is copied through descriptors before
 * semantic validation, and no caller-controlled callback or asynchronous boundary is crossed.
 */
export function createInstructionIrSnapshot(input: unknown): InstructionIrSnapshotResult {
  try {
    preflightRootCollections(input);
    const cloned = cloneJsonValue(input);
    const aggregate = enforceAggregateLimits(cloned.value);
    const validation = validateInstructionIr(cloned.value);
    if (!validation.ok) return failure(validation.issues);
    const snapshot = deepFreeze(validation.value) as InstructionIrSnapshot;
    const provenance: InstructionIrSnapshotProvenance = deepFreeze({
      algorithm: "sha256-canonical-b03-v1" as const,
      contractVersion: INSTRUCTION_IR_SNAPSHOT_CONTRACT_VERSION,
      counts: {
        activationRules: snapshot.activationRules.length,
        documents: snapshot.documents.length,
        events: snapshot.events.length,
        imports: snapshot.imports.length,
        nodes: snapshot.nodes.length,
        sources: snapshot.sources.length,
        statements: snapshot.statements.length,
        targets: snapshot.targets.length,
      },
      digest: canonicalDigest(snapshot),
      instructionIrContractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
      recordKind: "agent-context-instruction-ir-snapshot-provenance" as const,
      usage: {
        jsonStringBytes: cloned.usage.stringBytes,
        jsonValues: cloned.usage.values,
        sourceUtf16CodeUnits: aggregate.sourceUtf16CodeUnits,
        sourceUtf8Bytes: aggregate.sourceUtf8Bytes,
      },
    });
    SNAPSHOT_PROVENANCE.set(snapshot, provenance);
    return Object.freeze({ ok: true, provenance, value: snapshot });
  } catch (error) {
    if (error instanceof SnapshotFailure) return failure([error.issue]);
    return failure([
      issue("invalid-json", "$", "instruction IR could not be inspected safely for snapshotting"),
    ]);
  }
}

/** True only for the exact immutable B03 object issued by this process. */
export function isIssuedInstructionIrSnapshot(value: unknown): value is InstructionIrSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    !nodeTypes.isProxy(value) &&
    SNAPSHOT_PROVENANCE.has(value)
  );
}

/** Return immutable snapshot provenance without trusting any public property on the candidate. */
export function getInstructionIrSnapshotProvenance(
  value: unknown,
): InstructionIrSnapshotProvenance | undefined {
  return isIssuedInstructionIrSnapshot(value) ? SNAPSHOT_PROVENANCE.get(value) : undefined;
}
