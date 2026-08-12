import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath, type RepositoryRelativePath } from "@agent-context/core";
import {
  loadImportGraph,
  type ImportGraphResult,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import { GEMINI_CLI_PROFILE } from "@agent-context/profiles";
import {
  GeminiSettingsError,
  mergeGeminiSettingsLayers,
  parseGeminiContext,
  type GeminiContextParseResult,
  type GeminiSettingsLayerInput,
  type GeminiSettingsMergeResult,
} from "@agent-context/syntax";

export const GEMINI_CLI_RESOLVER_CONTRACT_VERSION = "0.1.0" as const;
export interface GeminiCliResolverLimits {
  readonly maximumBoundaryDirectories: number;
  readonly maximumCandidates: number;
  readonly maximumEvents: number;
  readonly maximumIdentityBytes: number;
  readonly maximumIgnoredBy: number;
  readonly maximumIssues: number;
  readonly maximumPathBytes: number;
  readonly maximumRoots: number;
}

export const GEMINI_CLI_RESOLVER_LIMITS: Readonly<GeminiCliResolverLimits> = Object.freeze({
  maximumBoundaryDirectories: 4_096,
  maximumCandidates: 65_536,
  maximumEvents: 4_096,
  maximumIdentityBytes: 16_384,
  maximumIgnoredBy: 32,
  maximumIssues: 4_096,
  maximumPathBytes: 16_384,
  maximumRoots: 256,
});

export type GeminiCliCandidateKind = "directory" | "file" | "unavailable";

export interface GeminiCliCandidateSnapshot {
  readonly identity: string | null;
  readonly ignoredBy: readonly string[];
  readonly kind: GeminiCliCandidateKind;
  readonly path: RepositoryRelativePath;
}

export type GeminiCliEventKind =
  "directory-add" | "launch" | "list-directory" | "memory-reload" | "read-path" | "write-path";

export interface GeminiCliEventSnapshot {
  readonly id: string;
  readonly kind: GeminiCliEventKind;
  readonly path: RepositoryRelativePath | null;
}

export interface ResolveGeminiCliInput {
  readonly boundaryMarkerDirectories: readonly RepositoryRelativePath[];
  readonly candidates: readonly GeminiCliCandidateSnapshot[];
  readonly events: readonly GeminiCliEventSnapshot[];
  readonly externalContext: "explicit-synthetic" | "unavailable";
  readonly repository: ReadOnlyRepository;
  readonly settingsLayers: readonly GeminiSettingsLayerInput[];
  readonly trustState: "trusted" | "untrusted" | "unknown";
  readonly workspaceRoots: readonly RepositoryRelativePath[];
}

export type GeminiCliIssueCode =
  | "absolute-import-unsupported"
  | "candidate-unavailable"
  | "discovery-uncertain"
  | "flat-import-depth-safety-cap"
  | "ignore-memory-contradiction"
  | "import-partial"
  | "include-root-unavailable"
  | "settings-contradiction"
  | "syntax-failed"
  | "target-outside-roots"
  | "untrusted-workspace";

export interface GeminiCliIssue {
  readonly code: GeminiCliIssueCode;
  readonly evidenceRefs: readonly string[];
  readonly eventId: string | null;
  readonly path: RepositoryRelativePath | null;
  readonly reason: string;
}

export interface GeminiCliDocumentDecision {
  readonly firstLoadedEventId: string;
  readonly ignoredBy: readonly string[];
  readonly importGraph: ImportGraphResult | null;
  readonly path: RepositoryRelativePath;
  readonly phase: "jit" | "static";
  readonly state: "loaded" | "unavailable";
  readonly syntax: GeminiContextParseResult | null;
}

export interface GeminiCliEventDecision {
  readonly added: readonly RepositoryRelativePath[];
  readonly id: string;
  readonly kind: GeminiCliEventKind;
  readonly loadedAfterEvent: readonly RepositoryRelativePath[];
  readonly path: RepositoryRelativePath | null;
  readonly state: "applied" | "ignored-untrusted" | "outside-roots";
}

export interface GeminiCliResolution {
  readonly analysisStatus: "complete" | "partial";
  readonly contractVersion: typeof GEMINI_CLI_RESOLVER_CONTRACT_VERSION;
  readonly documents: readonly GeminiCliDocumentDecision[];
  readonly events: readonly GeminiCliEventDecision[];
  readonly externalContext: ResolveGeminiCliInput["externalContext"];
  readonly issues: readonly GeminiCliIssue[];
  readonly loadedPaths: readonly RepositoryRelativePath[];
  readonly profile: typeof GEMINI_CLI_PROFILE;
  readonly recordKind: "agent-context-gemini-cli-resolution";
  readonly settings: GeminiSettingsMergeResult;
  readonly staticPaths: readonly RepositoryRelativePath[];
  readonly trustState: ResolveGeminiCliInput["trustState"];
  readonly workspaceRoots: readonly RepositoryRelativePath[];
}

const ISSUED_GEMINI_CLI_RESOLUTIONS = new WeakSet<object>();

/** True only for resolutions produced by this process's D10 resolver. */
export function isIssuedGeminiCliResolution(value: unknown): value is GeminiCliResolution {
  return typeof value === "object" && value !== null && ISSUED_GEMINI_CLI_RESOLUTIONS.has(value);
}

export class GeminiCliProfileError extends Error {
  override readonly name = "GeminiCliProfileError" as const;
  readonly code: "GEMINI_CLI_PROFILE_INVALID_INPUT" | "GEMINI_CLI_PROFILE_RESOURCE_LIMIT";

  constructor(code: GeminiCliProfileError["code"], message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

interface Snapshot extends Omit<ResolveGeminiCliInput, "repository"> {
  readonly repository: ReadOnlyRepository;
}

const INPUT_KEYS = new Set([
  "boundaryMarkerDirectories",
  "candidates",
  "events",
  "externalContext",
  "repository",
  "settingsLayers",
  "trustState",
  "workspaceRoots",
]);
const CANDIDATE_KEYS = new Set(["identity", "ignoredBy", "kind", "path"]);
const EVENT_KEYS = new Set(["id", "kind", "path"]);
const EVENT_KINDS = new Set<GeminiCliEventKind>([
  "directory-add",
  "launch",
  "list-directory",
  "memory-reload",
  "read-path",
  "write-path",
]);

function fail(code: GeminiCliProfileError["code"], message: string): never {
  throw new GeminiCliProfileError(code, message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function closedRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!plainRecord(value))
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", `${label} must be a plain record`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  )
    return fail(
      "GEMINI_CLI_PROFILE_INVALID_INPUT",
      `${label} must contain exactly documented fields`,
    );
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail(
        "GEMINI_CLI_PROFILE_INVALID_INPUT",
        `${label} fields must be enumerable data properties`,
      );
    result[key] = descriptor.value;
  }
  return result;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", `${label} must be a canonical repository path`);
  if (Buffer.byteLength(value, "utf8") > GEMINI_CLI_RESOLVER_LIMITS.maximumPathBytes)
    return fail("GEMINI_CLI_PROFILE_RESOURCE_LIMIT", `${label} exceeds the path limit`);
  return value;
}

function boundedArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value))
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", `${label} must be an array`);
  if (value.length > maximum)
    return fail("GEMINI_CLI_PROFILE_RESOURCE_LIMIT", `${label} exceeds its limit`);
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index))
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", `${label} must be dense`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > GEMINI_CLI_RESOLVER_LIMITS.maximumIdentityBytes
  )
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", `${label} must be a bounded string`);
  return value;
}

function snapshot(inputValue: ResolveGeminiCliInput): Snapshot {
  const input = closedRecord(inputValue, INPUT_KEYS, "Gemini resolver input");
  const repository = input["repository"];
  if (typeof repository !== "object" || repository === null || nodeTypes.isProxy(repository))
    return fail(
      "GEMINI_CLI_PROFILE_INVALID_INPUT",
      "repository must be a non-proxy read-only capability",
    );
  const candidateValues = boundedArray(
    input["candidates"],
    GEMINI_CLI_RESOLVER_LIMITS.maximumCandidates,
    "candidates",
  );
  const seenPaths = new Set<string>();
  const candidates = candidateValues.map((value, index): GeminiCliCandidateSnapshot => {
    const record = closedRecord(value, CANDIDATE_KEYS, `candidates[${String(index)}]`);
    const path = pathValue(record["path"], `candidates[${String(index)}].path`);
    if (seenPaths.has(path))
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "candidate paths must be unique");
    seenPaths.add(path);
    const kind = record["kind"];
    if (kind !== "directory" && kind !== "file" && kind !== "unavailable")
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "candidate kind is invalid");
    const identity = record["identity"];
    if (identity !== null && typeof identity !== "string")
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "candidate identity must be string or null");
    const ignoredBy = boundedArray(
      record["ignoredBy"],
      GEMINI_CLI_RESOLVER_LIMITS.maximumIgnoredBy,
      "candidate ignoredBy",
    ).map((entry) => stringValue(entry, "ignore source"));
    return Object.freeze({
      identity: identity === null ? null : stringValue(identity, "candidate identity"),
      ignoredBy: Object.freeze(ignoredBy),
      kind,
      path,
    });
  });
  const eventValues = boundedArray(
    input["events"],
    GEMINI_CLI_RESOLVER_LIMITS.maximumEvents,
    "events",
  );
  const eventIds = new Set<string>();
  const events = eventValues.map((value, index): GeminiCliEventSnapshot => {
    const record = closedRecord(value, EVENT_KEYS, `events[${String(index)}]`);
    const id = stringValue(record["id"], "event id");
    if (eventIds.has(id))
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "event ids must be unique");
    eventIds.add(id);
    const kind = record["kind"];
    if (typeof kind !== "string" || !EVENT_KINDS.has(kind as GeminiCliEventKind))
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "event kind is invalid");
    const eventKind = kind as GeminiCliEventKind;
    const path = record["path"] === null ? null : pathValue(record["path"], "event path");
    if (eventKind !== "memory-reload" && path === null)
      return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "non-reload events require a path");
    return Object.freeze({ id, kind: eventKind, path });
  });
  if (events[0]?.kind !== "launch")
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "event trace must begin with launch");
  const workspaceRoots = boundedArray(
    input["workspaceRoots"],
    GEMINI_CLI_RESOLVER_LIMITS.maximumRoots,
    "workspaceRoots",
  ).map((value) => pathValue(value, "workspace root"));
  if (workspaceRoots.length === 0)
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "workspaceRoots must not be empty");
  const boundaryMarkerDirectories = boundedArray(
    input["boundaryMarkerDirectories"],
    GEMINI_CLI_RESOLVER_LIMITS.maximumBoundaryDirectories,
    "boundaryMarkerDirectories",
  ).map((value) => pathValue(value, "boundary marker directory"));
  const externalContext = input["externalContext"];
  if (externalContext !== "explicit-synthetic" && externalContext !== "unavailable")
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "externalContext is invalid");
  const trustState = input["trustState"];
  if (trustState !== "trusted" && trustState !== "untrusted" && trustState !== "unknown")
    return fail("GEMINI_CLI_PROFILE_INVALID_INPUT", "trustState is invalid");
  const settingsLayers = boundedArray(
    input["settingsLayers"],
    8,
    "settingsLayers",
  ) as readonly GeminiSettingsLayerInput[];
  return Object.freeze({
    boundaryMarkerDirectories: Object.freeze([...new Set(boundaryMarkerDirectories)].sort()),
    candidates: Object.freeze(candidates),
    events: Object.freeze(events),
    externalContext,
    repository: repository as ReadOnlyRepository,
    settingsLayers: Object.freeze([...settingsLayers]),
    trustState,
    workspaceRoots: Object.freeze([...new Set(workspaceRoots)]),
  });
}

function contains(root: RepositoryRelativePath, candidate: RepositoryRelativePath): boolean {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function parent(path: RepositoryRelativePath): RepositoryRelativePath {
  const index = path.lastIndexOf("/");
  return index < 0
    ? ("." as RepositoryRelativePath)
    : (path.slice(0, index) as RepositoryRelativePath);
}

function ancestors(path: RepositoryRelativePath): readonly RepositoryRelativePath[] {
  if (path === ".") return Object.freeze(["." as RepositoryRelativePath]);
  const parts = path.split("/");
  const result: RepositoryRelativePath[] = ["." as RepositoryRelativePath];
  for (let index = 1; index <= parts.length; index += 1)
    result.push(parts.slice(0, index).join("/") as RepositoryRelativePath);
  return Object.freeze(result);
}

function nearestBoundary(
  path: RepositoryRelativePath,
  root: RepositoryRelativePath,
  markerDirectories: ReadonlySet<RepositoryRelativePath>,
  markersEnabled: boolean,
): RepositoryRelativePath {
  if (!markersEnabled) return root;
  const chain = ancestors(path).filter(
    (candidate) => contains(candidate, root) || contains(root, candidate),
  );
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate !== undefined && markerDirectories.has(candidate)) return candidate;
  }
  return root;
}

function directoriesBetween(
  ceiling: RepositoryRelativePath,
  leaf: RepositoryRelativePath,
): readonly RepositoryRelativePath[] {
  return ancestors(leaf).filter((directory) => contains(ceiling, directory));
}

function deepestRoot(
  roots: readonly RepositoryRelativePath[],
  path: RepositoryRelativePath,
): RepositoryRelativePath | null {
  return (
    roots
      .filter((root) => contains(root, path))
      .sort(
        (left, right) =>
          right.split("/").length - left.split("/").length || left.localeCompare(right),
      )[0] ?? null
  );
}

function join(directory: RepositoryRelativePath, name: string): RepositoryRelativePath {
  return (directory === "." ? name : `${directory}/${name}`) as RepositoryRelativePath;
}

function issue(
  code: GeminiCliIssueCode,
  reason: string,
  evidenceRefs: readonly string[],
  path: RepositoryRelativePath | null = null,
  eventId: string | null = null,
): GeminiCliIssue {
  return Object.freeze({
    code,
    eventId,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    path,
    reason,
  });
}

function appendIssue(issues: GeminiCliIssue[], value: GeminiCliIssue): void {
  if (issues.length < GEMINI_CLI_RESOLVER_LIMITS.maximumIssues) issues.push(value);
}

function restrictedRepository(
  repository: ReadOnlyRepository,
  boundary: RepositoryRelativePath,
): ReadOnlyRepository {
  return Object.freeze({
    limits: repository.limits,
    root: repository.root,
    inspect: repository.inspect.bind(repository),
    readDirectory: repository.readDirectory.bind(repository),
    readFile: (value: unknown) => {
      if (
        typeof value !== "string" ||
        !isRepositoryRelativePath(value) ||
        !contains(boundary, value)
      )
        return Promise.reject(new Error("Gemini import target is outside its memory boundary"));
      return repository.readFile(value);
    },
    usage: repository.usage.bind(repository),
  });
}

/** Resolve a complete explicit event trace without consulting environment, home state, or network. */
export async function resolveGeminiCliContext(
  inputValue: ResolveGeminiCliInput,
): Promise<GeminiCliResolution> {
  const input = snapshot(inputValue);
  let settings: GeminiSettingsMergeResult;
  try {
    settings = mergeGeminiSettingsLayers(input.settingsLayers);
  } catch (error: unknown) {
    if (error instanceof GeminiSettingsError)
      throw new GeminiCliProfileError(
        error.code === "GEMINI_SETTINGS_RESOURCE_LIMIT"
          ? "GEMINI_CLI_PROFILE_RESOURCE_LIMIT"
          : "GEMINI_CLI_PROFILE_INVALID_INPUT",
        error.message,
      );
    throw error;
  }
  const issues: GeminiCliIssue[] = settings.issues.map((entry) =>
    issue("discovery-uncertain", entry.message, ["GEM-SET-001", "GEM-SET-006"], entry.path),
  );
  const candidateByPath = new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
  const markerDirectories = new Set(input.boundaryMarkerDirectories);
  const roots: RepositoryRelativePath[] = [...input.workspaceRoots];
  for (const include of settings.values.includeDirectories) {
    if (candidateByPath.get(include)?.kind === "directory") roots.push(include);
    else
      appendIssue(
        issues,
        issue(
          "include-root-unavailable",
          "Configured include directory is absent from the authorized inventory.",
          ["GEM-SET-002"],
          include,
        ),
      );
  }
  const activeRoots = [...new Set(roots)].sort();
  if (settings.values.discoveryMaxDirs !== 200)
    appendIssue(
      issues,
      issue(
        "settings-contradiction",
        "discoveryMaxDirs has no effect in the pinned ancestor/JIT path.",
        ["GEM-SET-004"],
      ),
    );
  if (settings.values.includeDirectories.length > 0)
    appendIssue(
      issues,
      issue(
        "settings-contradiction",
        "Include-root reload behavior remains contradicted; roots and refresh events are reported separately.",
        ["GEM-SET-003"],
      ),
    );

  const loadedIdentities = new Set<string>();
  const loadedPaths = new Set<RepositoryRelativePath>();
  const staticPaths = new Set<RepositoryRelativePath>();
  const documents: GeminiCliDocumentDecision[] = [];
  const eventDecisions: GeminiCliEventDecision[] = [];

  const candidatesForDirectories = (
    directories: readonly RepositoryRelativePath[],
  ): GeminiCliCandidateSnapshot[] => {
    const found: GeminiCliCandidateSnapshot[] = [];
    for (const directory of directories) {
      for (const name of settings.values.fileNames) {
        const candidate = candidateByPath.get(join(directory, name));
        if (candidate?.kind === "file" || candidate?.kind === "unavailable") found.push(candidate);
      }
    }
    const identities = new Set<string>();
    return found
      .filter((candidate) => {
        const key =
          candidate.identity === null ? `path:${candidate.path}` : `identity:${candidate.identity}`;
        if (identities.has(key)) return false;
        identities.add(key);
        return true;
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  };

  const startupCandidates = (): GeminiCliCandidateSnapshot[] => {
    const directories = activeRoots.flatMap((root) =>
      directoriesBetween(
        nearestBoundary(
          root,
          root,
          markerDirectories,
          settings.values.memoryBoundaryMarkers.length > 0,
        ),
        root,
      ),
    );
    return candidatesForDirectories(directories);
  };

  const loadCandidate = async (
    candidate: GeminiCliCandidateSnapshot,
    phase: GeminiCliDocumentDecision["phase"],
    eventId: string,
  ): Promise<boolean> => {
    const identityKey =
      candidate.identity === null ? `path:${candidate.path}` : `identity:${candidate.identity}`;
    if (loadedIdentities.has(identityKey)) return false;
    loadedIdentities.add(identityKey);
    loadedPaths.add(candidate.path);
    if (phase === "static") staticPaths.add(candidate.path);
    if (candidate.ignoredBy.length > 0)
      appendIssue(
        issues,
        issue(
          "ignore-memory-contradiction",
          "Ignore matching is reported but does not deactivate pinned memory discovery.",
          ["GEM-IGN-003", "GEM-GAP-008"],
          candidate.path,
          eventId,
        ),
      );
    if (candidate.kind === "unavailable") {
      appendIssue(
        issues,
        issue(
          "candidate-unavailable",
          "Selected context bytes are unavailable through the safe repository facade.",
          ["GEM-LOC-002"],
          candidate.path,
          eventId,
        ),
      );
      documents.push(
        Object.freeze({
          firstLoadedEventId: eventId,
          ignoredBy: candidate.ignoredBy,
          importGraph: null,
          path: candidate.path,
          phase,
          state: "unavailable",
          syntax: null,
        }),
      );
      return true;
    }
    let syntax: GeminiContextParseResult | null = null;
    try {
      const file = await input.repository.readFile(candidate.path);
      syntax = parseGeminiContext({
        bytes: file.bytes(),
        contentStatus: "complete",
        path: candidate.path,
        scopeRoot: parent(candidate.path),
      });
    } catch {
      appendIssue(
        issues,
        issue(
          "syntax-failed",
          "Selected context could not be read or parsed safely.",
          ["GEM-IMP-001"],
          candidate.path,
          eventId,
        ),
      );
    }
    const fileDirectory = parent(candidate.path);
    const boundary = nearestBoundary(
      fileDirectory,
      fileDirectory,
      markerDirectories,
      settings.values.memoryBoundaryMarkers.length > 0,
    );
    const importGraph = await loadImportGraph(
      {
        repository: restrictedRepository(input.repository, boundary),
        entryPath: candidate.path,
        syntax: "gemini-cli",
      },
      {
        maxDepth: settings.values.importFormat === "tree" ? 5 : 32,
        maxEdges: 2_048,
        maxFanOut: 128,
        maxFileBytes: 524_288,
        maxFiles: 256,
        maxIssues: 256,
        maxTotalBytes: 8_388_608,
      },
    );
    if (syntax?.imports.some((reference) => reference.rawSpecifier.startsWith("/")) === true)
      appendIssue(
        issues,
        issue(
          "absolute-import-unsupported",
          "Pinned Gemini permits contained absolute imports, but C10 rejects them safely pending a boundary-aware absolute-path contract.",
          ["GEM-IMP-003"],
          candidate.path,
          eventId,
        ),
      );
    if (settings.values.importFormat === "flat")
      appendIssue(
        issues,
        issue(
          "flat-import-depth-safety-cap",
          "Pinned flat mode lacks its documented depth limit; the linter applies its own finite safety cap.",
          ["GEM-IMP-006", "GEM-GAP-004"],
          candidate.path,
          eventId,
        ),
      );
    if (importGraph.state === "partial")
      appendIssue(
        issues,
        issue(
          "import-partial",
          "One or more imports were unavailable, rejected, cyclic, or resource-limited.",
          ["GEM-IMP-003", "GEM-IMP-005", "GEM-IMP-006"],
          candidate.path,
          eventId,
        ),
      );
    documents.push(
      Object.freeze({
        firstLoadedEventId: eventId,
        ignoredBy: candidate.ignoredBy,
        importGraph,
        path: candidate.path,
        phase,
        state: "loaded",
        syntax,
      }),
    );
    return true;
  };

  for (const event of input.events) {
    const added: RepositoryRelativePath[] = [];
    if (input.trustState !== "trusted") {
      if (event.kind === "launch")
        appendIssue(
          issues,
          issue(
            "untrusted-workspace",
            "Workspace and JIT memory are suppressed without explicit trust.",
            ["GEM-LOC-005"],
            event.path,
            event.id,
          ),
        );
      eventDecisions.push(
        Object.freeze({
          added: Object.freeze([]),
          id: event.id,
          kind: event.kind,
          loadedAfterEvent: Object.freeze([...loadedPaths].sort()),
          path: event.path,
          state: "ignored-untrusted",
        }),
      );
      continue;
    }
    let selected: readonly GeminiCliCandidateSnapshot[] = [];
    let eventState: GeminiCliEventDecision["state"] = "applied";
    if (event.kind === "launch") selected = startupCandidates();
    else if (event.kind === "memory-reload") {
      loadedIdentities.clear();
      loadedPaths.clear();
      staticPaths.clear();
      selected = startupCandidates();
    } else if (event.kind === "directory-add" && event.path !== null) {
      if (!activeRoots.includes(event.path)) activeRoots.push(event.path);
      if (settings.values.loadMemoryFromIncludeDirectories) selected = startupCandidates();
    } else if (event.path !== null) {
      const root = deepestRoot(activeRoots, event.path);
      if (root === null) {
        eventState = "outside-roots";
        appendIssue(
          issues,
          issue(
            "target-outside-roots",
            "JIT target is outside every trusted workspace root.",
            ["GEM-JIT-002"],
            event.path,
            event.id,
          ),
        );
      } else {
        const targetDirectory =
          candidateByPath.get(event.path)?.kind === "directory" ? event.path : parent(event.path);
        const ceiling = nearestBoundary(
          root,
          root,
          markerDirectories,
          settings.values.memoryBoundaryMarkers.length > 0,
        );
        selected = candidatesForDirectories(directoriesBetween(ceiling, targetDirectory));
      }
    }
    for (const candidate of selected) {
      const loaded = await loadCandidate(
        candidate,
        event.kind === "launch" || event.kind === "memory-reload" || event.kind === "directory-add"
          ? "static"
          : "jit",
        event.id,
      );
      if (loaded) added.push(candidate.path);
    }
    eventDecisions.push(
      Object.freeze({
        added: Object.freeze(added),
        id: event.id,
        kind: event.kind,
        loadedAfterEvent: Object.freeze([...loadedPaths].sort()),
        path: event.path,
        state: eventState,
      }),
    );
  }

  const result: GeminiCliResolution = Object.freeze({
    analysisStatus: issues.length === 0 && settings.state === "complete" ? "complete" : "partial",
    contractVersion: GEMINI_CLI_RESOLVER_CONTRACT_VERSION,
    documents: Object.freeze(documents),
    events: Object.freeze(eventDecisions),
    externalContext: input.externalContext,
    issues: Object.freeze(issues.slice(0, GEMINI_CLI_RESOLVER_LIMITS.maximumIssues)),
    loadedPaths: Object.freeze([...loadedPaths].sort()),
    profile: GEMINI_CLI_PROFILE,
    recordKind: "agent-context-gemini-cli-resolution",
    settings,
    staticPaths: Object.freeze([...staticPaths].sort()),
    trustState: input.trustState,
    workspaceRoots: Object.freeze([...activeRoots].sort()),
  });
  ISSUED_GEMINI_CLI_RESOLUTIONS.add(result);
  return result;
}
