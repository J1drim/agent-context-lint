import { types as nodeTypes } from "node:util";

import {
  isIssuedChangedFileScanScope,
  isIssuedChangedFileScanScopeForRepositorySelection,
  isIssuedGitChangedFileMetadata,
  isIssuedGitChangedFileMetadataForScope,
  isIssuedTargetedDiscoveryIndex,
  type ChangedFileScanScope,
  type GitChangedFileMetadata,
  type RepositoryRootSelection,
  type TargetedDiscoveryIndex,
} from "@agent-context/evidence";
import {
  TARGET_SAMPLER_DEFAULT_LIMITS,
  isIssuedEffectiveContextResolution,
  type EffectiveContextResolution,
} from "@agent-context/resolver";

import { CONFIGURATION_FILE_NAME } from "@agent-context/core";
import type { Diagnostic, DiagnosticId, RepositoryRelativePath } from "@agent-context/core";
import {
  doesIssuedConfigurationResolutionMatchRepository,
  isIssuedConfigurationResolutionSuccess,
  type ConfigurationResolutionSuccess,
} from "@agent-context/syntax";
import type { RuleSchedulerSuccess } from "./rule-scheduler.js";
import { isIssuedRuleSchedulerSuccess } from "./rule-scheduler.js";

export const CHANGED_FILE_MODE_CONTRACT_VERSION = "0.1.0" as const;
export const CHANGED_FILE_MODE_INPUT_KIND = "agent-context-changed-file-mode-input" as const;
export const CHANGED_FILE_MODE_RESULT_KIND = "agent-context-changed-file-mode-result" as const;

export interface ChangedFileModeLimits {
  readonly maximumChangedPathsForSubset: number;
  readonly maximumControlPaths: number;
  readonly maximumInstructionCandidatePaths: number;
  readonly maximumResolutions: number;
  readonly maximumSelectedPaths: number;
}

export const CHANGED_FILE_MODE_LIMITS: Readonly<ChangedFileModeLimits> = Object.freeze({
  maximumChangedPathsForSubset: TARGET_SAMPLER_DEFAULT_LIMITS.maximumCriticalPaths,
  maximumControlPaths: 4_096,
  maximumInstructionCandidatePaths: 65_536,
  maximumResolutions: 100_000,
  maximumSelectedPaths: 1_000_000,
});

export interface ChangedFileModeInput {
  readonly contractVersion: typeof CHANGED_FILE_MODE_CONTRACT_VERSION;
  readonly evidence: ChangedFileModeEvidenceAuthority;
  readonly metadata: GitChangedFileMetadata;
  readonly recordKind: typeof CHANGED_FILE_MODE_INPUT_KIND;
  readonly scope: ChangedFileScanScope;
}

export interface ChangedFileModeEvidenceAuthority {
  readonly contractVersion: typeof CHANGED_FILE_MODE_CONTRACT_VERSION;
  readonly kind: "agent-context-changed-file-mode-evidence";
}

export type ChangedFileModeFallbackReason =
  | "configuration-changed"
  | "git-metadata-unavailable"
  | "incomplete-discovery"
  | "incomplete-parser-result"
  | "incomplete-resolution"
  | "invalid-input"
  | "repository-changed"
  | "resource-limit"
  | "structural-change"
  | "unmapped-changed-path"
  | "unmapped-instruction-change"
  | "untracked-files";

export interface ChangedFileModeResult {
  readonly changedPaths: readonly RepositoryRelativePath[];
  readonly contractVersion: typeof CHANGED_FILE_MODE_CONTRACT_VERSION;
  readonly excludedDiagnosticIds: readonly DiagnosticId[];
  readonly includedDiagnosticIds: readonly DiagnosticId[];
  readonly mode: "changed" | "full";
  readonly reason: ChangedFileModeFallbackReason | null;
  readonly recordKind: typeof CHANGED_FILE_MODE_RESULT_KIND;
  readonly selectedPaths: readonly RepositoryRelativePath[];
}

type DataRecord = Readonly<Record<string, unknown>>;

const INPUT_KEYS = new Set(["contractVersion", "evidence", "metadata", "recordKind", "scope"]);
const ISSUED_EVIDENCE = new WeakMap<
  object,
  Readonly<{
    readonly controlPaths: readonly RepositoryRelativePath[];
    readonly discoveryComplete: boolean;
    readonly instructionPaths: readonly RepositoryRelativePath[];
    readonly criticalPathsComplete: boolean;
    readonly resolutions: readonly EffectiveContextResolution[];
    readonly scheduler: RuleSchedulerSuccess;
    readonly scope: ChangedFileScanScope;
  }>
>();
const ALWAYS_VISIBLE_RULES = new Set(
  Array.from({ length: 10 }, (_, index) => `ACL${String(100 + index)}`),
);
const DEPENDENCY_SCOPE_AMBIGUITIES = new Set([
  "activation",
  "import-resolution",
  "partial-profile",
  "target-scope",
]);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function dataRecord(value: unknown): DataRecord | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as DataRecord) : null;
}

function own(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
    ? descriptor.value
    : undefined;
}

function resolutionArray(value: unknown): readonly EffectiveContextResolution[] | null {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > CHANGED_FILE_MODE_LIMITS.maximumResolutions ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return null;
  const output: EffectiveContextResolution[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !isIssuedEffectiveContextResolution(descriptor.value)
    )
      return null;
    const resolution = descriptor.value;
    const identity = `${resolution.profileId}\u0000${resolution.surfaceId}\u0000${resolution.targetPath}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    output.push(resolution);
  }
  return Object.freeze(
    output.sort((left, right) =>
      compareUtf8(
        `${left.targetPath}\u0000${left.profileId}\u0000${left.surfaceId}`,
        `${right.targetPath}\u0000${right.profileId}\u0000${right.surfaceId}`,
      ),
    ),
  );
}

function discoveryPaths(
  discovery: TargetedDiscoveryIndex,
  kind: "configuration" | "instruction",
  maximum: number,
): readonly RepositoryRelativePath[] | null {
  const paths = discovery.candidates
    .filter((candidate) => candidate.kinds.includes(kind))
    .map((candidate) => candidate.path);
  return paths.length <= maximum ? Object.freeze(paths.sort(compareUtf8)) : null;
}

function controlPaths(
  configuration: ConfigurationResolutionSuccess,
  discovery: TargetedDiscoveryIndex,
): readonly RepositoryRelativePath[] | null {
  const paths = new Set<RepositoryRelativePath>([
    CONFIGURATION_FILE_NAME as RepositoryRelativePath,
    configuration.value.standards.lockfile,
  ]);
  for (const candidate of discovery.candidates) {
    if (candidate.kinds.includes("configuration")) paths.add(candidate.path);
  }
  return paths.size <= CHANGED_FILE_MODE_LIMITS.maximumControlPaths
    ? Object.freeze([...paths].sort(compareUtf8))
    : null;
}

/** Bind issued C01, B06/B07, C05, E05, and F15 evidence to one opaque Git scan operation. */
export function createChangedFileModeEvidenceAuthority(
  scope: ChangedFileScanScope,
  selectionValue: RepositoryRootSelection,
  configurationValue: ConfigurationResolutionSuccess,
  discoveryValue: TargetedDiscoveryIndex,
  resolutionsValue: readonly EffectiveContextResolution[],
  schedulerValue: RuleSchedulerSuccess,
  criticalPathsComplete = true,
): ChangedFileModeEvidenceAuthority {
  const resolutions = resolutionArray(resolutionsValue);
  const controls =
    isIssuedConfigurationResolutionSuccess(configurationValue) &&
    isIssuedTargetedDiscoveryIndex(discoveryValue)
      ? controlPaths(configurationValue, discoveryValue)
      : null;
  const instructionPaths = isIssuedTargetedDiscoveryIndex(discoveryValue)
    ? discoveryPaths(
        discoveryValue,
        "instruction",
        CHANGED_FILE_MODE_LIMITS.maximumInstructionCandidatePaths,
      )
    : null;
  const configurationMatchesSelection =
    isIssuedChangedFileScanScopeForRepositorySelection(scope, selectionValue) &&
    doesIssuedConfigurationResolutionMatchRepository(
      configurationValue,
      selectionValue.root,
      selectionValue.identity.device,
      selectionValue.identity.inode,
    );
  const schedulerSourcePaths = isIssuedRuleSchedulerSuccess(schedulerValue)
    ? new Set(schedulerValue.sources.map((source) => source.path))
    : null;
  if (
    !isIssuedChangedFileScanScope(scope) ||
    !configurationMatchesSelection ||
    controls === null ||
    instructionPaths === null ||
    schedulerSourcePaths === null ||
    !instructionPaths.every((path) => schedulerSourcePaths.has(path)) ||
    typeof criticalPathsComplete !== "boolean" ||
    resolutions === null ||
    !isIssuedRuleSchedulerSuccess(schedulerValue)
  )
    throw new TypeError("changed-file evidence must be issued for one scan operation");
  const authority = Object.freeze({
    contractVersion: CHANGED_FILE_MODE_CONTRACT_VERSION,
    kind: "agent-context-changed-file-mode-evidence" as const,
  });
  ISSUED_EVIDENCE.set(
    authority,
    Object.freeze({
      controlPaths: controls,
      criticalPathsComplete,
      discoveryComplete: discoveryValue.uncertainty === "known",
      instructionPaths,
      resolutions,
      scheduler: schedulerValue,
      scope,
    }),
  );
  return authority;
}

function diagnosticPaths(diagnostic: Diagnostic): readonly RepositoryRelativePath[] {
  const paths = new Set<RepositoryRelativePath>([diagnostic.primary.path]);
  for (const evidence of diagnostic.related) {
    if (evidence.kind === "source") paths.add(evidence.location.path);
    else if (evidence.kind === "repository-fact") {
      if (evidence.subjectPath !== null) paths.add(evidence.subjectPath);
      for (const location of evidence.locations) paths.add(location.path);
    } else if (evidence.kind === "resolution") {
      for (const location of evidence.sourceLocations) paths.add(location.path);
    }
  }
  return Object.freeze([...paths]);
}

function sortedIds(values: readonly Diagnostic[]): readonly DiagnosticId[] {
  return Object.freeze(values.map(({ id }) => id).sort(compareUtf8));
}

function dependencyScopeComplete(resolution: EffectiveContextResolution): boolean {
  // E05 assembly may remain partial solely because external, ordering, precedence, or exact-text
  // composition is unknown. Those uncertainties do not hide repository path relationships. Path
  // selection is unsafe only when target activation, imported paths, or the profile inventory is
  // incomplete.
  return !resolution.ambiguities.some((entry) => DEPENDENCY_SCOPE_AMBIGUITIES.has(entry.kind));
}

function result(
  scheduler: RuleSchedulerSuccess | null,
  changedPaths: readonly RepositoryRelativePath[],
  selectedPaths: ReadonlySet<RepositoryRelativePath>,
  mode: "changed" | "full",
  reason: ChangedFileModeFallbackReason | null,
): ChangedFileModeResult {
  // Selection authority covers the complete canonical bundle. Visibility is a separate scheduler
  // view used only for exit policy; suppressed diagnostics and their bookkeeping must survive when
  // they are relevant to the selected dependency closure.
  const diagnostics = scheduler?.bundle.diagnostics ?? [];
  const visibleDiagnosticIds = new Set(scheduler?.visibleDiagnostics.map(({ id }) => id) ?? []);
  const selected = Object.freeze([...selectedPaths].sort(compareUtf8));
  const included =
    mode === "full"
      ? diagnostics
      : diagnostics.filter(
          (diagnostic) =>
            (ALWAYS_VISIBLE_RULES.has(diagnostic.ruleId) &&
              visibleDiagnosticIds.has(diagnostic.id) &&
              diagnostic.primary.path === ".") ||
            diagnosticPaths(diagnostic).some((path) => selectedPaths.has(path)),
        );
  const includedSet = new Set(included.map(({ id }) => id));
  const excluded = diagnostics.filter(({ id }) => !includedSet.has(id));
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    contractVersion: CHANGED_FILE_MODE_CONTRACT_VERSION,
    excludedDiagnosticIds: sortedIds(excluded),
    includedDiagnosticIds: sortedIds(included),
    mode,
    reason,
    recordKind: CHANGED_FILE_MODE_RESULT_KIND,
    selectedPaths: selected,
  });
}

function full(
  scheduler: RuleSchedulerSuccess | null,
  changedPaths: readonly RepositoryRelativePath[],
  selectedPaths: ReadonlySet<RepositoryRelativePath>,
  reason: ChangedFileModeFallbackReason,
): ChangedFileModeResult {
  return result(scheduler, changedPaths, selectedPaths, "full", reason);
}

/**
 * Expand changed Git paths through E05 target/document/import relationships and select F15 output.
 * Any input that cannot prove a complete safe subset returns a full-scan plan.
 */
export function planChangedFileMode(input: ChangedFileModeInput): ChangedFileModeResult {
  const empty = new Set<RepositoryRelativePath>();
  const record = dataRecord(input);
  if (
    record === null ||
    Reflect.ownKeys(record).length !== INPUT_KEYS.size ||
    Reflect.ownKeys(record).some((key) => typeof key !== "string" || !INPUT_KEYS.has(key)) ||
    own(record, "contractVersion") !== CHANGED_FILE_MODE_CONTRACT_VERSION ||
    own(record, "recordKind") !== CHANGED_FILE_MODE_INPUT_KIND
  )
    return full(null, [], empty, "invalid-input");

  const scope = own(record, "scope");
  const evidenceValue = own(record, "evidence");
  const evidence =
    typeof evidenceValue === "object" && evidenceValue !== null
      ? ISSUED_EVIDENCE.get(evidenceValue)
      : undefined;
  const scheduler = evidence?.scheduler ?? null;
  const metadata = own(record, "metadata");
  if (
    scheduler === null ||
    evidence === undefined ||
    evidence.scope !== scope ||
    !isIssuedGitChangedFileMetadata(metadata) ||
    !isIssuedGitChangedFileMetadataForScope(metadata, scope) ||
    !isIssuedChangedFileScanScope(scope)
  )
    return full(scheduler, [], empty, "invalid-input");
  const resolutions = evidence.resolutions;
  const controlPaths = evidence.controlPaths;
  const instructionPaths = evidence.instructionPaths;
  if (metadata.state === "fallback")
    return full(
      scheduler,
      [],
      empty,
      metadata.reason === "repository-changed"
        ? "repository-changed"
        : metadata.reason === "untracked-files"
          ? "untracked-files"
          : "git-metadata-unavailable",
    );
  if (!evidence.discoveryComplete) return full(scheduler, [], empty, "incomplete-discovery");
  if (!evidence.criticalPathsComplete) return full(scheduler, [], empty, "resource-limit");

  const changedPaths = Object.freeze(
    [
      ...new Set(
        metadata.changes.flatMap((change) =>
          [change.path, change.previousPath].filter(
            (value): value is RepositoryRelativePath => value !== null,
          ),
        ),
      ),
    ].sort(compareUtf8),
  );
  const selected = new Set<RepositoryRelativePath>(changedPaths);
  if (changedPaths.length > CHANGED_FILE_MODE_LIMITS.maximumChangedPathsForSubset)
    return full(scheduler, changedPaths, selected, "resource-limit");
  if (
    metadata.changes.some(
      ({ status }) =>
        status === "deleted" ||
        status === "renamed" ||
        status === "copied" ||
        status === "type-changed",
    )
  )
    return full(scheduler, changedPaths, selected, "structural-change");
  const controls = new Set(controlPaths);
  if (changedPaths.some((path) => controls.has(path)))
    return full(scheduler, changedPaths, selected, "configuration-changed");
  if (scheduler.sources.some(({ parseState }) => parseState.state !== "complete"))
    return full(scheduler, changedPaths, selected, "incomplete-parser-result");
  if (resolutions.some((resolution) => !dependencyScopeComplete(resolution)))
    return full(scheduler, changedPaths, selected, "incomplete-resolution");

  const instructionCandidates = new Set(instructionPaths);
  const mappedInstructions = new Set<RepositoryRelativePath>();
  const targetPaths = new Set<RepositoryRelativePath>();
  for (const resolution of resolutions) {
    targetPaths.add(resolution.targetPath);
    const resolutionPaths = new Set<RepositoryRelativePath>([resolution.targetPath]);
    for (const document of resolution.documents) {
      mappedInstructions.add(document.path);
      if (document.state !== "inactive" && document.state !== "shadowed")
        resolutionPaths.add(document.path);
    }
    for (const occurrence of resolution.occurrences) {
      if (occurrence.targetPath !== null) {
        resolutionPaths.add(occurrence.targetPath);
        mappedInstructions.add(occurrence.targetPath);
      }
    }
    if (changedPaths.some((path) => resolutionPaths.has(path)))
      for (const path of resolutionPaths) selected.add(path);
    if (selected.size > CHANGED_FILE_MODE_LIMITS.maximumSelectedPaths)
      return full(scheduler, changedPaths, selected, "resource-limit");
  }
  for (const changedPath of changedPaths) {
    if (instructionCandidates.has(changedPath) && !mappedInstructions.has(changedPath))
      return full(scheduler, changedPaths, selected, "unmapped-instruction-change");
    if (
      !instructionCandidates.has(changedPath) &&
      !mappedInstructions.has(changedPath) &&
      !targetPaths.has(changedPath)
    ) {
      const representedByDiagnostic = scheduler.visibleDiagnostics.some((diagnostic) =>
        diagnosticPaths(diagnostic).includes(changedPath),
      );
      if (!representedByDiagnostic)
        return full(scheduler, changedPaths, selected, "unmapped-changed-path");
    }
  }
  return result(scheduler, changedPaths, selected, "changed", null);
}
