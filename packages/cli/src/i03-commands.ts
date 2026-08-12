import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  CONFIGURATION_FILE_NAME,
  canonicalizeRepositoryRelativePath,
  sanitizeOutputJson,
  sanitizeOutputText,
  type AgentContextConfiguration,
  type ConfigurationProfileId,
  type ConfigurationSurfaceId,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  applyIgnoreRules,
  buildTargetedDiscoveryIndex,
  createReadOnlyRepository,
  enumerateTrackedFiles,
  loadImportGraph,
  selectRepositoryRoot,
  type DiscoveryCandidate,
  type ImportGraphResult,
  type ReadOnlyRepository,
  type ReadOnlyRepositoryIdentity,
  type RepositoryRootSelection,
  type TargetedDiscoveryIndex,
  type TrackedFileEnumerationReason,
} from "@agent-context/evidence";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EXPLAIN_PROJECTION_CONTRACT_VERSION,
  EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
  RESOLUTION_EVENT_TRACE_LIMITS,
  buildDocumentImportDag,
  buildInstructionList,
  createSyntheticTargetTrace,
  normalizeResolutionEventTrace,
  projectExplain,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  type ClaudeCodeProfileResolution,
  type ClaudeInstructionCandidateSnapshot,
  type ClaudeRuntimeEvent,
  type CodexCliAgentsResolution,
  type CopilotInstructionCandidateSnapshot,
  type CopilotProfileResolution,
  type CursorProfileResolution,
  type CursorRuleCandidateSnapshot,
  type CursorRuntimeEvent,
  type CursorRuntimeSnapshot,
  type EffectiveContextProfileResolution,
  type GeminiCliCandidateSnapshot,
  type GeminiCliEventSnapshot,
  type GeminiCliResolution,
  type InstructionListResult,
  type ResolutionEventTrace,
} from "@agent-context/resolver";
import { RULE_REGISTRY, RULE_REGISTRY_VERSION } from "@agent-context/rules";
import { resolveAgentContextConfiguration } from "@agent-context/syntax";

import { writeBoundedOutput } from "./bounded-output.js";
import type {
  CliAgentProfile,
  CliCommandContext,
  CliCommandHandler,
  CliCommandHandlers,
  CliOutputFormat,
  CliSurface,
} from "./command-router.js";

export const I03_OUTPUT_CONTRACT_VERSION = "0.1.0" as const;
export const STARTER_CONFIGURATION = `# Agent Context Linter configuration.
# Omitted settings use documented, versioned defaults.
version: 1

# Override only policy that differs from the defaults. See docs/api/configuration.md.
rules: {}
ignore: []
`;

export interface RepositoryContext {
  readonly configuration: AgentContextConfiguration;
  readonly discovery: TargetedDiscoveryIndex;
  readonly includedPaths: readonly RepositoryRelativePath[];
  readonly importRepository: ReadOnlyRepository;
  readonly repository: ReadOnlyRepository;
  readonly selection: RepositoryRootSelection;
  readonly trackingCertainty: "all-files-not-tracked" | "tracked";
  readonly trackingReason: TrackedFileEnumerationReason;
}

export interface CandidateBytes {
  readonly candidate: DiscoveryCandidate;
  readonly bytes: Uint8Array;
  readonly identity: ReadOnlyRepositoryIdentity;
}

export interface Resolutions {
  readonly claudeCode: readonly ClaudeCodeProfileResolution[];
  readonly codexCli: readonly CodexCliAgentsResolution[];
  readonly copilot: readonly CopilotProfileResolution[];
  readonly cursor: readonly CursorProfileResolution[];
  readonly geminiCli: readonly {
    readonly candidates: readonly GeminiCliCandidateSnapshot[];
    readonly resolution: GeminiCliResolution;
  }[];
}

interface SelectedResolution {
  readonly importGraphs: readonly ImportGraphResult[];
  readonly profileResolution: EffectiveContextProfileResolution;
}

interface I03CommandOptions {
  readonly workingDirectory: string;
}

const PROFILE_IDS = new Set<ConfigurationProfileId>([
  "claude-code",
  "codex-cli",
  "copilot-cli",
  "copilot-cloud-agent",
  "copilot-code-review",
  "copilot-vscode",
  "cursor-agent",
  "gemini-cli",
]);
const COPILOT_SURFACES: Readonly<
  Record<Extract<CliAgentProfile, `copilot-${string}`>, ConfigurationSurfaceId>
> = Object.freeze({
  "copilot-cli": "copilot-cli/local-terminal",
  "copilot-cloud-agent": "copilot-cloud-agent/github-hosted",
  "copilot-code-review": "copilot-code-review/github-hosted",
  "copilot-vscode": "copilot-vscode/local-chat",
});
const ABORT_SIGNAL_THROW_IF_ABORTED = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "throwIfAborted",
)?.value as (this: AbortSignal) => void;

function throwIfAborted(signal: AbortSignal): void {
  Reflect.apply(ABORT_SIGNAL_THROW_IF_ABORTED, signal, []);
}

function rootPath(): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(".");
}

function isInstruction(candidate: DiscoveryCandidate, recognizerId: string): boolean {
  return candidate.recognitions.some((item) => item.recognizerId === recognizerId);
}

function profileEnabled(
  configuration: AgentContextConfiguration,
  profile: ConfigurationProfileId,
): boolean {
  return configuration.profiles[profile].enabled;
}

function surfaceEnabled(
  configuration: AgentContextConfiguration,
  profile: ConfigurationProfileId,
  surface: ConfigurationSurfaceId,
): boolean {
  return (
    profileEnabled(configuration, profile) &&
    configuration.profiles[profile].surfaces[surface] !== false
  );
}

function relativeTarget(
  root: string,
  workingDirectory: string,
  supplied: string,
): RepositoryRelativePath {
  const absolute = path.resolve(workingDirectory, supplied);
  const relative = path.relative(root, absolute);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("target is outside repository");
  return canonicalizeRepositoryRelativePath(
    relative === "" ? "." : relative.split(path.sep).join("/"),
  );
}

async function buildRepositoryDiscovery(
  repository: ReadOnlyRepository,
  configuration: AgentContextConfiguration,
  signal: AbortSignal,
): Promise<{
  readonly discovery: TargetedDiscoveryIndex;
  readonly includedPaths: readonly RepositoryRelativePath[];
  readonly trackingCertainty: "all-files-not-tracked" | "tracked";
  readonly trackingReason: TrackedFileEnumerationReason;
}> {
  const enumeration = await enumerateTrackedFiles(repository, {
    maximumDepth: configuration.limits.maxTraversalDepth,
    maximumFiles: configuration.limits.maxFiles,
  });
  const ignored = await applyIgnoreRules(repository, enumeration, {
    configurationPatterns: configuration.ignore,
    maximumPaths: configuration.limits.maxFiles,
    signal,
  });
  return Object.freeze({
    discovery: buildTargetedDiscoveryIndex(enumeration, ignored, {
      maximumCandidates: configuration.limits.maxFiles,
      maximumPaths: configuration.limits.maxFiles,
      signal,
    }),
    includedPaths: ignored.paths,
    trackingCertainty: enumeration.certainty,
    trackingReason: enumeration.reason,
  });
}

function createIncludedRepository(
  repository: ReadOnlyRepository,
  includedPaths: readonly RepositoryRelativePath[],
): ReadOnlyRepository {
  const included = new Set(includedPaths);
  return Object.freeze({
    inspect: (relativePath: unknown) => repository.inspect(relativePath),
    limits: repository.limits,
    readDirectory: (relativePath: unknown) => repository.readDirectory(relativePath),
    readFile: async (relativePath: unknown) => {
      if (typeof relativePath !== "string" || !included.has(relativePath as RepositoryRelativePath))
        throw new Error("path is outside the C04 included universe");
      return repository.readFile(relativePath);
    },
    root: repository.root,
    usage: () => repository.usage(),
  });
}

async function repositoryContext(
  workingDirectory: string,
  operand: string | undefined,
  signal: AbortSignal,
): Promise<RepositoryContext> {
  const selectedPath =
    operand === undefined ? workingDirectory : path.resolve(workingDirectory, operand);
  const selection = await selectRepositoryRoot(selectedPath, {
    mode: operand === undefined ? "discover" : "explicit",
    signal,
  });
  const resolved = await resolveAgentContextConfiguration(selection.root);
  if (!resolved.ok) throw new Error("repository configuration is invalid");
  const repository = await createReadOnlyRepository(selection, {
    maximumEntries: resolved.value.limits.maxFiles,
    // Enumeration inspects metadata for ignored files before C04 filtering. Preserve the C02 hard
    // ceiling here and apply the configured content ceiling only to instruction reads below.
    maximumFileBytes: 16_777_216,
    maximumTotalBytes: resolved.value.limits.maxTotalBytes,
    maximumTraversalDepth: resolved.value.limits.maxTraversalDepth,
    signal,
  });
  const discovered = await buildRepositoryDiscovery(repository, resolved.value, signal);
  return Object.freeze({
    configuration: resolved.value,
    discovery: discovered.discovery,
    includedPaths: discovered.includedPaths,
    importRepository: createIncludedRepository(repository, discovered.includedPaths),
    repository,
    selection,
    trackingCertainty: discovered.trackingCertainty,
    trackingReason: discovered.trackingReason,
  });
}

async function readCandidates(context: RepositoryContext): Promise<readonly CandidateBytes[]> {
  const result: CandidateBytes[] = [];
  for (const candidate of context.discovery.candidates) {
    if (!candidate.kinds.includes("instruction")) continue;
    const file = await context.repository.readFile(candidate.path);
    if (file.size > context.configuration.limits.maxFileBytes)
      throw new Error("instruction file exceeds configured byte limit");
    result.push(Object.freeze({ bytes: file.bytes(), candidate, identity: file.identity }));
  }
  return Object.freeze(result);
}

async function loadCandidateImportGraph(
  context: RepositoryContext,
  entryPath: RepositoryRelativePath,
  syntax: "claude-code" | "copilot-cli" | "cursor-agent" | "gemini-cli",
): Promise<ImportGraphResult> {
  return loadImportGraph(
    { entryPath, repository: context.importRepository, syntax },
    {
      maxDepth: Math.min(context.configuration.limits.maxImportDepth, 32),
      maxFanOut: Math.min(context.configuration.limits.maxImportFanOut, 256),
      maxFileBytes: Math.min(context.configuration.limits.maxFileBytes, 524_288),
      maxTotalBytes: Math.min(context.configuration.limits.maxTotalBytes, 16_777_216),
    },
  );
}

function traceTargetIds(
  trace: ResolutionEventTrace,
  target: RepositoryRelativePath,
): ReadonlySet<string> {
  return new Set(trace.targets.filter((entry) => entry.path === target).map((entry) => entry.id));
}

function eventAppliesToTarget(
  targetIds: ReadonlySet<string>,
  event: ResolutionEventTrace["events"][number],
): boolean {
  return event.kind === "launch" || event.targetId === null || targetIds.has(event.targetId);
}

function requireKnownProfileEvent(
  event: ResolutionEventTrace["events"][number],
  supported: boolean,
): void {
  if (supported && event.uncertainty.state !== "known")
    throw new Error("profile event state must be known");
}

function traceLaunch(trace: ResolutionEventTrace): ResolutionEventTrace["events"][number] & {
  readonly kind: "launch";
} {
  const launch = trace.events[0];
  if (launch?.kind !== "launch" || launch.uncertainty.state !== "known")
    throw new Error("trace launch state must be known");
  return launch;
}

function explainTrace(
  supplied: ResolutionEventTrace | null,
  target: RepositoryRelativePath,
): ResolutionEventTrace {
  if (supplied !== null) {
    if (!supplied.targets.some((entry) => entry.path === target))
      throw new Error("trace does not contain the explained target");
    traceLaunch(supplied);
    return supplied;
  }
  return createSyntheticTargetTrace({
    launchCwd: rootPath(),
    purpose: "agent-context-lint-explain",
    targetEventKind: "read-path",
    targetPath: target,
    workspaceRoots: [rootPath()],
  });
}

function codexResolution(
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  certainty: "known" | "uncertain",
  launchCwd: RepositoryRelativePath = rootPath(),
): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty,
      entries: candidates
        .filter(
          ({ candidate }) =>
            isInstruction(candidate, "instruction.agents-base") ||
            isInstruction(candidate, "instruction.agents-override"),
        )
        .map(({ bytes, candidate }) => ({
          bytes,
          errorCode: null,
          kind: "file" as const,
          path: candidate.path,
          resolvedTarget: null,
        })),
      reason:
        certainty === "known"
          ? "complete CLI repository discovery"
          : "fallback CLI repository discovery",
      rootMarkerPaths: [],
    },
    externalContext: { mode: "unavailable" },
    launchCwd,
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [],
    },
    targetPath: target,
  });
}

function claudeCandidates(
  candidates: readonly CandidateBytes[],
  importGraphs: ReadonlyMap<RepositoryRelativePath, ImportGraphResult> = new Map(),
): readonly ClaudeInstructionCandidateSnapshot[] {
  return Object.freeze(
    candidates.flatMap(({ bytes, candidate }) => {
      let kind: ClaudeInstructionCandidateSnapshot["kind"] | null = null;
      if (isInstruction(candidate, "instruction.claude-rules")) kind = "project-rule";
      else if (isInstruction(candidate, "instruction.claude-local")) kind = "memory-local";
      else if (isInstruction(candidate, "instruction.claude-memory"))
        kind = candidate.path.endsWith(".claude/CLAUDE.md") ? "memory-alternate" : "memory-shared";
      return kind === null
        ? []
        : [
            {
              absolutePath: null,
              bytes,
              importGraph: importGraphs.get(candidate.path) ?? null,
              kind,
              origin: "repository" as const,
              path: candidate.path,
              scopeRoot: rootPath(),
              symlinkState: "none" as const,
            },
          ];
    }),
  );
}

function claudeTraceEvents(
  trace: ResolutionEventTrace,
  target: RepositoryRelativePath,
): readonly ClaudeRuntimeEvent[] {
  const targetIds = traceTargetIds(trace, target);
  const output: ClaudeRuntimeEvent[] = [];
  for (const event of trace.events) {
    if (!eventAppliesToTarget(targetIds, event)) continue;
    const supported =
      event.kind === "launch" || event.kind === "compact" || event.kind === "read-path";
    requireKnownProfileEvent(event, supported);
    if (event.kind === "launch")
      output.push(Object.freeze({ id: event.id, kind: "launch", path: event.path }));
    else if (event.kind === "compact")
      output.push(Object.freeze({ id: event.id, kind: "compact", path: null }));
    else if (event.kind === "read-path")
      output.push(Object.freeze({ id: event.id, kind: "read", path: event.path }));
  }
  return Object.freeze(output);
}

async function claudeResolution(
  context: RepositoryContext,
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  trace?: ResolutionEventTrace,
  loadImports = false,
): Promise<{
  readonly importGraphs: readonly ImportGraphResult[];
  readonly resolution: ClaudeCodeProfileResolution;
}> {
  const selectedCandidates = claudeCandidates(candidates);
  const importGraphs = new Map<RepositoryRelativePath, ImportGraphResult>();
  if (loadImports)
    for (const candidate of selectedCandidates)
      importGraphs.set(
        candidate.path,
        await loadCandidateImportGraph(context, candidate.path, "claude-code"),
      );
  const launchPath = trace === undefined ? rootPath() : traceLaunch(trace).path;
  const eventTrace =
    trace === undefined
      ? Object.freeze([
          Object.freeze({ id: "static-launch", kind: "launch" as const, path: rootPath() }),
          Object.freeze({ id: "static-target", kind: "read" as const, path: target }),
        ])
      : claudeTraceEvents(trace, target);
  const resolution = resolveClaudeCodeProfile({
    candidates: claudeCandidates(candidates, importGraphs),
    launchCwd: launchPath,
    repositoryRoot: rootPath(),
    runtime: {
      additionalDirectoryInstructions: "disabled",
      clientVersion: "2.1.217",
      eventTrace,
      exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
      externalContext: "unavailable",
      mode: "normal",
      settingSources: { state: "known", values: ["project"] },
    },
  });
  return Object.freeze({ importGraphs: Object.freeze([...importGraphs.values()]), resolution });
}

function copilotCandidates(
  candidates: readonly CandidateBytes[],
): readonly CopilotInstructionCandidateSnapshot[] {
  return Object.freeze(
    candidates.flatMap<CopilotInstructionCandidateSnapshot>(({ bytes, candidate }) => {
      if (isInstruction(candidate, "instruction.copilot-repository"))
        return [{ bytes, format: "repository-wide" as const, path: candidate.path }];
      if (isInstruction(candidate, "instruction.copilot-path"))
        return [{ bytes, format: "path-specific" as const, path: candidate.path }];
      return [];
    }),
  );
}

function copilotResolution(
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  profile: Extract<CliAgentProfile, `copilot-${string}`>,
): CopilotProfileResolution {
  const snapshots = copilotCandidates(candidates);
  if (profile === "copilot-cli")
    return resolveCopilotProfile({
      candidates: snapshots,
      profileId: profile,
      runtime: {
        disabledPaths: [],
        eventState: "present",
        kind: profile,
        standardLocations: [{ kind: "repository-root", path: rootPath() }],
        targetPaths: [target],
      },
    });
  if (profile === "copilot-vscode")
    return resolveCopilotProfile({
      candidates: snapshots,
      profileId: profile,
      runtime: {
        applyingInstructions: "enabled",
        eventState: "present",
        instructionFolders: [
          {
            path: canonicalizeRepositoryRelativePath(".github/instructions"),
            workspaceRoot: rootPath(),
          },
        ],
        kind: profile,
        manualAttachments: [],
        targetPaths: [target],
        workspaceRoots: [rootPath()],
      },
    });
  if (profile === "copilot-cloud-agent")
    return resolveCopilotProfile({
      candidates: snapshots,
      profileId: profile,
      runtime: {
        eventState: "present",
        kind: profile,
        repositoryRoot: rootPath(),
        targetPaths: [target],
      },
    });
  return resolveCopilotProfile({
    candidates: snapshots,
    profileId: profile,
    runtime: {
      customInstructions: "enabled",
      eventState: "present",
      kind: profile,
      repositoryRoot: rootPath(),
      targetPaths: [target],
    },
  });
}

function cursorCandidates(
  candidates: readonly CandidateBytes[],
): readonly CursorRuleCandidateSnapshot[] {
  return Object.freeze(
    candidates.flatMap<CursorRuleCandidateSnapshot>(({ bytes, candidate }) => {
      if (isInstruction(candidate, "instruction.cursor-mdc"))
        return [{ bytes, format: "mdc" as const, path: candidate.path }];
      if (isInstruction(candidate, "instruction.cursor-legacy"))
        return [{ bytes, format: "legacy" as const, path: candidate.path }];
      return [];
    }),
  );
}

function cursorResolution(
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  surfaceId: "cursor-agent/cli" | "cursor-agent/ide",
  trace?: ResolutionEventTrace,
): CursorProfileResolution {
  const snapshots = cursorCandidates(candidates);
  const runtime = (events: readonly CursorRuntimeEvent[]): CursorRuntimeSnapshot =>
    Object.freeze({
      clientVersion: surfaceId === "cursor-agent/ide" ? "3.12.30" : "2026.05.24-dda726e",
      eventState: events.length === 0 ? ("absent" as const) : ("present" as const),
      events,
      externalContext: "absent" as const,
      projectRules: "enabled" as const,
      surfaceId,
      workspaceRoots: [rootPath()],
    });
  if (trace === undefined)
    return resolveCursorProfile({
      candidates: snapshots,
      runtime: runtime([{ kind: "read-path", sequence: 0, targetPath: target }]),
    });

  const targetIds = traceTargetIds(trace, target);
  const pathEvents: CursorRuntimeEvent[] = [];
  for (const event of trace.events) {
    if (!eventAppliesToTarget(targetIds, event)) continue;
    const supported =
      event.kind === "read-path" ||
      event.kind === "reference-path" ||
      event.kind === "write-path" ||
      event.kind === "manual-rule-mention" ||
      event.kind === "rule-selection";
    requireKnownProfileEvent(event, supported);
    if (
      event.kind === "read-path" ||
      event.kind === "reference-path" ||
      event.kind === "write-path"
    )
      pathEvents.push({ kind: event.kind, sequence: pathEvents.length, targetPath: event.path });
  }
  const initial = resolveCursorProfile({ candidates: snapshots, runtime: runtime(pathEvents) });
  const candidateByDocumentId = new Map(
    initial.candidates.map((candidate) => [candidate.syntax.documentId, candidate]),
  );
  const ruleById = new Map(trace.rules.map((rule) => [rule.id, rule]));
  const cursorRuleCandidate = (
    ruleId: ResolutionEventTrace["rules"][number]["id"],
    kind: "conditional" | "manual",
  ): CursorProfileResolution["candidates"][number] | undefined => {
    const rule = ruleById.get(ruleId);
    if (
      rule?.kind !== kind ||
      rule.profileId !== initial.profile.profileId ||
      rule.surfaceId !== initial.profile.surfaceId ||
      rule.specSnapshotId !== initial.profile.specSnapshotId
    )
      return undefined;
    return candidateByDocumentId.get(rule.documentId);
  };
  const events: CursorRuntimeEvent[] = [];
  for (const event of trace.events) {
    if (!eventAppliesToTarget(targetIds, event)) continue;
    const supported =
      event.kind === "read-path" ||
      event.kind === "reference-path" ||
      event.kind === "write-path" ||
      event.kind === "manual-rule-mention" ||
      event.kind === "rule-selection";
    requireKnownProfileEvent(event, supported);
    if (
      event.kind === "read-path" ||
      event.kind === "reference-path" ||
      event.kind === "write-path"
    ) {
      events.push({ kind: event.kind, sequence: events.length, targetPath: event.path });
      continue;
    }
    const eventTarget =
      event.targetId === null
        ? target
        : (trace.targets.find((entry) => entry.id === event.targetId)?.path ?? target);
    if (event.kind === "manual-rule-mention") {
      const candidate = cursorRuleCandidate(event.ruleId, "manual");
      if (candidate !== undefined)
        events.push({
          candidatePath: candidate.path,
          kind: "manual-rule-mention",
          ruleName: candidate.ruleName,
          sequence: events.length,
          targetPath: eventTarget,
        });
    } else if (event.kind === "rule-selection") {
      for (const ruleId of event.ruleIds) {
        const candidate = cursorRuleCandidate(ruleId, "conditional");
        if (candidate !== undefined)
          events.push({
            candidatePath: candidate.path,
            kind: "agent-rule-selection",
            selection: event.selectionSource === "unknown" ? "unknown" : "selected",
            sequence: events.length,
            targetPath: eventTarget,
          });
      }
    }
  }
  return resolveCursorProfile({
    candidates: snapshots,
    runtime: runtime(events),
  });
}

function geminiCandidates(
  candidates: readonly CandidateBytes[],
): readonly GeminiCliCandidateSnapshot[] {
  return Object.freeze(
    candidates.flatMap(({ candidate }) =>
      isInstruction(candidate, "instruction.gemini-context")
        ? [
            {
              identity: createHash("sha256").update(candidate.path).digest("hex"),
              ignoredBy: [],
              kind: "file" as const,
              path: candidate.path,
            },
          ]
        : [],
    ),
  );
}

async function geminiResolution(
  context: RepositoryContext,
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  trace?: ResolutionEventTrace,
): Promise<{
  readonly candidates: readonly GeminiCliCandidateSnapshot[];
  readonly resolution: GeminiCliResolution;
}> {
  const snapshots = geminiCandidates(candidates);
  const targetIds = trace === undefined ? new Set<string>() : traceTargetIds(trace, target);
  const events: GeminiCliEventSnapshot[] = [];
  if (trace === undefined) {
    events.push(
      { id: "static-launch", kind: "launch", path: rootPath() },
      { id: "static-target", kind: "read-path", path: target },
    );
  } else {
    for (const event of trace.events) {
      if (!eventAppliesToTarget(targetIds, event)) continue;
      const supported =
        event.kind === "launch" ||
        event.kind === "directory-add" ||
        event.kind === "list-directory" ||
        event.kind === "read-path" ||
        event.kind === "write-path" ||
        event.kind === "memory-reload";
      requireKnownProfileEvent(event, supported);
      if (
        event.kind === "launch" ||
        event.kind === "directory-add" ||
        event.kind === "list-directory" ||
        event.kind === "read-path" ||
        event.kind === "write-path"
      )
        events.push(Object.freeze({ id: event.id, kind: event.kind, path: event.path }));
      else if (event.kind === "memory-reload")
        events.push(Object.freeze({ id: event.id, kind: event.kind, path: null }));
    }
  }
  const resolution = await resolveGeminiCliContext({
    boundaryMarkerDirectories: [rootPath()],
    candidates: snapshots,
    events,
    externalContext: "unavailable",
    repository: context.importRepository,
    settingsLayers: [],
    trustState: "trusted",
    workspaceRoots: [rootPath()],
  });
  return Object.freeze({ candidates: snapshots, resolution });
}

export async function allResolutions(
  context: RepositoryContext,
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
): Promise<Resolutions> {
  const configuration = context.configuration;
  const copilot: CopilotProfileResolution[] = [];
  for (const profile of [
    "copilot-cli",
    "copilot-vscode",
    "copilot-cloud-agent",
    "copilot-code-review",
  ] as const) {
    const surface = COPILOT_SURFACES[profile];
    if (surfaceEnabled(configuration, profile, surface))
      copilot.push(copilotResolution(candidates, target, profile));
  }
  const cursor: CursorProfileResolution[] = [];
  for (const surface of ["cursor-agent/cli", "cursor-agent/ide"] as const)
    if (surfaceEnabled(configuration, "cursor-agent", surface))
      cursor.push(cursorResolution(candidates, target, surface));
  const geminiCli = profileEnabled(configuration, "gemini-cli")
    ? [await geminiResolution(context, candidates, target)]
    : [];
  return Object.freeze({
    claudeCode: profileEnabled(configuration, "claude-code")
      ? [(await claudeResolution(context, candidates, target)).resolution]
      : [],
    codexCli: profileEnabled(configuration, "codex-cli")
      ? [codexResolution(candidates, target, context.discovery.uncertainty)]
      : [],
    copilot: Object.freeze(copilot),
    cursor: Object.freeze(cursor),
    geminiCli: Object.freeze(geminiCli),
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(sanitizeOutputJson(value), null, 2)}\n`;
}

function renderList(result: InstructionListResult, format: CliOutputFormat): string {
  const envelope = {
    contractVersion: I03_OUTPUT_CONTRACT_VERSION,
    entries: result.entries,
    recordKind: "agent-context-instruction-list",
    summary: result.summary,
  };
  if (format === "json") return json(envelope);
  const rows = result.entries.map(
    (entry) =>
      `${entry.state.padEnd(11)} ${entry.profileId.padEnd(21)} ${entry.surfaceId.padEnd(39)} ${(entry.scopeRoot ?? "-").padEnd(20)} ${entry.path} (${entry.decisionCode})`,
  );
  return [
    "STATE       PROFILE               SURFACE                                 SCOPE                PATH",
    ...rows,
    `Total ${String(result.summary.total)}: ${String(result.summary.supported)} supported, ${String(result.summary.conditional)} conditional, ${String(result.summary.ignored)} ignored, ${String(result.summary.recognized)} recognized, ${String(result.summary.malformed)} malformed.`,
    "",
  ].join("\n");
}

function renderRules(format: CliOutputFormat): string {
  const envelope = {
    contractVersion: I03_OUTPUT_CONTRACT_VERSION,
    recordKind: "agent-context-rule-list",
    registryVersion: RULE_REGISTRY_VERSION,
    rules: RULE_REGISTRY.rules,
    summary: { total: RULE_REGISTRY.rules.length },
  };
  if (format === "json") return json(envelope);
  return [
    "ID      SEVERITY  CATEGORY                 PRECISION    FIX          DESCRIPTION",
    ...RULE_REGISTRY.rules.map(
      (rule) =>
        `${rule.id.padEnd(7)} ${rule.defaultSeverity.padEnd(9)} ${rule.category.padEnd(24)} ${rule.precisionStatus.padEnd(12)} ${rule.fixSafety.padEnd(12)} ${sanitizeOutputText(rule.description)}`,
    ),
    `Total: ${String(RULE_REGISTRY.rules.length)} rules.`,
    "",
  ].join("\n");
}

async function selectedResolution(
  profile: CliAgentProfile,
  context: RepositoryContext,
  candidates: readonly CandidateBytes[],
  target: RepositoryRelativePath,
  trace: ResolutionEventTrace,
  surface: CliSurface | null,
): Promise<SelectedResolution> {
  if (!PROFILE_IDS.has(profile) || !profileEnabled(context.configuration, profile))
    throw new Error("profile is disabled");
  if (profile === "codex-cli")
    return Object.freeze({
      importGraphs: Object.freeze([]),
      profileResolution: codexResolution(
        candidates,
        target,
        context.discovery.uncertainty,
        traceLaunch(trace).path,
      ),
    });
  if (profile === "claude-code") {
    const selected = await claudeResolution(context, candidates, target, trace, true);
    return Object.freeze({
      importGraphs: selected.importGraphs,
      profileResolution: selected.resolution,
    });
  }
  if (profile.startsWith("copilot-"))
    return Object.freeze({
      importGraphs: Object.freeze([]),
      profileResolution: copilotResolution(
        candidates,
        target,
        profile as Extract<CliAgentProfile, `copilot-${string}`>,
      ),
    });
  if (profile === "cursor-agent") {
    const selectedSurface = surface ?? "cursor-agent/ide";
    if (!surfaceEnabled(context.configuration, profile, selectedSurface))
      throw new Error("surface is disabled");
    return Object.freeze({
      importGraphs: Object.freeze([]),
      profileResolution: cursorResolution(candidates, target, selectedSurface, trace),
    });
  }
  const selected = await geminiResolution(context, candidates, target, trace);
  return Object.freeze({
    importGraphs: Object.freeze(
      selected.resolution.documents.flatMap((document) =>
        document.importGraph === null ? [] : [document.importGraph],
      ),
    ),
    profileResolution: selected.resolution,
  });
}

async function importDagsForResolution(
  context: RepositoryContext,
  resolution: EffectiveContextProfileResolution,
  trace: ResolutionEventTrace,
  suppliedGraphs: readonly ImportGraphResult[],
): Promise<readonly ReturnType<typeof buildDocumentImportDag>[]> {
  const graphs: ImportGraphResult[] = [...suppliedGraphs];
  if (resolution.recordKind === "agent-context-copilot-profile-resolution") {
    if (resolution.profile.profileId === "copilot-cli")
      for (const candidate of resolution.candidates)
        graphs.push(await loadCandidateImportGraph(context, candidate.path, "copilot-cli"));
  } else if (resolution.recordKind === "agent-context-cursor-profile-resolution") {
    for (const candidate of resolution.candidates)
      graphs.push(await loadCandidateImportGraph(context, candidate.path, "cursor-agent"));
  }
  return Object.freeze(graphs.map((graph) => buildDocumentImportDag({ graph, trace })));
}

function preflightTraceJson(text: string): void {
  let cursor = 0;
  let nodes = 0;
  const failJson = (): never => {
    throw new SyntaxError("trace is not strict duplicate-free JSON");
  };
  const whitespace = (): void => {
    while (
      text[cursor] === " " ||
      text[cursor] === "\t" ||
      text[cursor] === "\n" ||
      text[cursor] === "\r"
    )
      cursor += 1;
  };
  const stringToken = (decode: boolean): string => {
    const start = cursor;
    if (text[cursor] !== '"') return failJson();
    cursor += 1;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code < 0x20) return failJson();
      if (code === 0x22) {
        cursor += 1;
        if (!decode) return "";
        const value: unknown = JSON.parse(text.slice(start, cursor));
        return typeof value === "string" ? value : failJson();
      }
      if (code !== 0x5c) {
        cursor += 1;
        continue;
      }
      const escape = text[cursor + 1];
      if (escape === "u") {
        if (!/^[0-9A-Fa-f]{4}$/u.test(text.slice(cursor + 2, cursor + 6))) return failJson();
        cursor += 6;
      } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) cursor += 2;
      else return failJson();
    }
    return failJson();
  };
  const digits = (): number => {
    const start = cursor;
    while (text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x39) cursor += 1;
    return cursor - start;
  };
  const numberToken = (): void => {
    if (text[cursor] === "-") cursor += 1;
    if (text[cursor] === "0") cursor += 1;
    else {
      const first = text.charCodeAt(cursor);
      if (first < 0x31 || first > 0x39) return failJson();
      cursor += 1;
      digits();
    }
    if (text[cursor] === ".") {
      cursor += 1;
      if (digits() === 0) return failJson();
    }
    if (text[cursor] === "e" || text[cursor] === "E") {
      cursor += 1;
      if (text[cursor] === "+" || text[cursor] === "-") cursor += 1;
      if (digits() === 0) return failJson();
    }
  };
  const value = (depth: number): void => {
    whitespace();
    nodes += 1;
    if (
      nodes > RESOLUTION_EVENT_TRACE_LIMITS.maxJsonNodes ||
      depth > RESOLUTION_EVENT_TRACE_LIMITS.maxJsonDepth
    )
      throw new RangeError("trace JSON exceeds structural limits");
    const character = text[cursor];
    if (character === "{") object(depth + 1);
    else if (character === "[") array(depth + 1);
    else if (character === '"') stringToken(false);
    else if (character === "-" || (character !== undefined && character >= "0" && character <= "9"))
      numberToken();
    else if (text.startsWith("true", cursor)) cursor += 4;
    else if (text.startsWith("false", cursor)) cursor += 5;
    else if (text.startsWith("null", cursor)) cursor += 4;
    else failJson();
  };
  const object = (depth: number): void => {
    cursor += 1;
    whitespace();
    const keys = new Set<string>();
    if (text[cursor] === "}") {
      cursor += 1;
      return;
    }
    for (;;) {
      whitespace();
      const key = stringToken(true);
      if (keys.has(key)) throw new SyntaxError("trace JSON contains a duplicate object key");
      keys.add(key);
      whitespace();
      if (text[cursor] !== ":") return failJson();
      cursor += 1;
      value(depth);
      whitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") return failJson();
      cursor += 1;
    }
  };
  const array = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === "]") {
      cursor += 1;
      return;
    }
    for (;;) {
      value(depth);
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") return failJson();
      cursor += 1;
    }
  };
  value(0);
  whitespace();
  if (cursor !== text.length) failJson();
}

async function readTrace(
  context: RepositoryContext,
  workingDirectory: string,
  tracePath: string | null,
): Promise<ResolutionEventTrace | null> {
  if (tracePath === null) return null;
  const repositoryPath = relativeTarget(context.selection.lexicalRoot, workingDirectory, tracePath);
  const file = await context.repository.readFile(repositoryPath);
  if (file.size > RESOLUTION_EVENT_TRACE_LIMITS.maxInputTextBytes)
    throw new RangeError("trace exceeds its input byte limit");
  const bytes = file.bytes();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  preflightTraceJson(text);
  return normalizeResolutionEventTrace(JSON.parse(text) as unknown);
}

function renderExplain(
  projection: ReturnType<typeof projectExplain>,
  format: CliOutputFormat,
): string {
  const envelope = {
    contractVersion: I03_OUTPUT_CONTRACT_VERSION,
    explanation: projection,
    recordKind: "agent-context-explanation",
  };
  if (format === "json") return json(envelope);
  const output = [
    `Profile: ${projection.profileId} (${projection.surfaceId}, ${projection.profileVersion})`,
    `Analysis: ${projection.analysisStatus}`,
  ];
  for (const target of projection.targets) {
    output.push(`Target: ${target.targetPath}`);
    for (const document of target.documents) {
      output.push(
        `  ${document.disposition.padEnd(11)} ${document.path} [${document.reasons.map((reason) => reason.code).join(", ")}]`,
      );
      if (document.disposition === "included" && document.text !== null)
        for (const line of sanitizeOutputText(document.text).split("\n"))
          output.push(`    | ${line}`);
    }
    output.push(
      `  Documents: ${String(target.accounting.documents.included)} included, ${String(target.accounting.documents.conditional)} conditional, ${String(target.accounting.documents.excluded)} excluded.`,
    );
  }
  output.push("");
  return output.join("\n");
}

async function initializeRepository(
  workingDirectory: string,
  operand: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const selectedPath =
    operand === undefined ? workingDirectory : path.resolve(workingDirectory, operand);
  const selection = await selectRepositoryRoot(selectedPath, {
    mode: operand === undefined ? "discover" : "explicit",
    signal,
  });
  const target = path.join(selection.root, CONFIGURATION_FILE_NAME);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: { readonly dev: bigint; readonly ino: bigint } | undefined;
  try {
    throwIfAborted(signal);
    handle = await open(
      target,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o644,
    );
    const stats = await handle.stat({ bigint: true });
    identity = { dev: stats.dev, ino: stats.ino };
    throwIfAborted(signal);
    await handle.writeFile(STARTER_CONFIGURATION, { encoding: "utf8" });
    await handle.sync();
    throwIfAborted(signal);
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) await ignoreFailure(handle.close());
    if (identity !== undefined) {
      const current = await optionalLstat(target);
      if (current?.dev === identity.dev && current.ino === identity.ino)
        await ignoreFailure(unlink(target));
    }
    throw error;
  }
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // Cleanup is identity-guarded and best-effort; the original initialization error is primary.
  }
}

async function optionalLstat(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target, { bigint: true });
  } catch {
    return undefined;
  }
}

async function commandFailure(
  context: CliCommandContext,
  message: string,
): Promise<{ readonly status: "operational-failure" }> {
  await context.writeStderr(`agent-context-lint: ${message}.\n`);
  return { status: "operational-failure" };
}

/** Install I03 handlers. Construction is side-effect-free; filesystem access begins on invocation. */
export function createI03CommandHandlers(options: I03CommandOptions): CliCommandHandlers {
  const workingDirectory = path.resolve(options.workingDirectory);
  const list: CliCommandHandler = async (command) => {
    try {
      const context = await repositoryContext(
        workingDirectory,
        command.operands[0],
        command.signal,
      );
      const candidates = await readCandidates(context);
      const resolutions = await allResolutions(context, candidates, rootPath());
      const result = buildInstructionList(resolutions);
      await writeBoundedOutput(renderList(result, command.format), command.writeStdout);
      return { status: "success" };
    } catch {
      return commandFailure(command, "unable to list repository instructions");
    }
  };
  const rules: CliCommandHandler = async (command) => {
    try {
      await writeBoundedOutput(renderRules(command.format), command.writeStdout);
      return { status: "success" };
    } catch {
      return commandFailure(command, "unable to list rules");
    }
  };
  const explain: CliCommandHandler = async (command) => {
    try {
      const suppliedTarget = command.operands[0];
      if (suppliedTarget === undefined) throw new Error("missing target");
      const context = await repositoryContext(workingDirectory, undefined, command.signal);
      const target = relativeTarget(
        context.selection.lexicalRoot,
        workingDirectory,
        suppliedTarget,
      );
      const candidates = await readCandidates(context);
      const profile = command.agent ?? "codex-cli";
      const suppliedTrace = await readTrace(context, workingDirectory, command.tracePath);
      const trace = explainTrace(suppliedTrace, target);
      const selected = await selectedResolution(
        profile,
        context,
        candidates,
        target,
        trace,
        command.surface,
      );
      const importDags = await importDagsForResolution(
        context,
        selected.profileResolution,
        trace,
        selected.importGraphs,
      );
      const resolution = resolveEffectiveContext({
        contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
        importDags,
        profileResolution: selected.profileResolution,
        recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
        targetPath: target,
      });
      const projection = projectExplain({
        contractVersion: EXPLAIN_PROJECTION_CONTRACT_VERSION,
        recordKind: EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
        resolutions: [resolution],
        trace: suppliedTrace,
      });
      await writeBoundedOutput(renderExplain(projection, command.format), command.writeStdout);
      return { status: "success" };
    } catch {
      return commandFailure(command, "unable to explain repository instructions");
    }
  };
  const init: CliCommandHandler = async (command) => {
    try {
      await initializeRepository(workingDirectory, command.operands[0], command.signal);
      await command.writeStdout(`Created ${CONFIGURATION_FILE_NAME}.\n`);
      return { status: "success" };
    } catch {
      return commandFailure(
        command,
        "configuration was not created; the target may already exist or be unsafe",
      );
    }
  };
  return Object.freeze({ explain, init, list, rules });
}
